const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// Environment config (set via firebase functions:secrets:set)
const CLAUDE_API_KEY = defineSecret("CLAUDE_API_KEY");
const YELP_API_KEY = defineSecret("YELP_API_KEY");

// ============ CORS HELPER ============
function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function handleCors(req, res) {
  const headers = corsHeaders(req);
  Object.entries(headers).forEach(([k, v]) => res.set(k, v));
  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  return false;
}

// ============ AUTH HELPER ============
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  try {
    return await admin.auth().verifyIdToken(authHeader.split("Bearer ")[1]);
  } catch { return null; }
}

// ============ CONCIERGE — AI RECOMMENDATIONS ============
exports.concierge = onRequest({ cors: false, secrets: ["CLAUDE_API_KEY"] }, async (req, res) => {
  if (handleCors(req, res)) return;
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    // Load user data from Firestore
    const [restaurantsSnap, mattPref, denisePref, sourcesSnap] = await Promise.all([
      db.collection("restaurants").get(),
      db.doc("preferences/matt").get(),
      db.doc("preferences/denise").get(),
      db.collection("trustedSources").get(),
    ]);

    const restaurants = restaurantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const mattPrefs = mattPref.exists ? mattPref.data() : {};
    const denisePrefs = denisePref.exists ? denisePref.data() : {};
    const sources = sourcesSnap.docs.map(d => d.data());

    // Build context for Claude
    const visited = restaurants.filter(r => r.visits && r.visits.length > 0);
    const wishlist = restaurants.filter(r => r.status === "wishlist" || r.status === "recommended");

    const visitedSummary = visited.map(r => {
      const mr = r.mattRating || 0;
      const dr = r.deniseRating || 0;
      return `- ${r.name} (${r.neighborhood}, ${(r.cuisine||[]).join("/")}, ${"$".repeat(r.priceRange||2)}): Matt ${mr}/5, Denise ${dr}/5. ${r.mattNotes || ""} ${r.deniseNotes || ""}`.trim();
    }).join("\n");

    const wishlistSummary = wishlist.map(r => {
      const src = r.source ? ` (recommended by ${r.source.name})` : "";
      const endorsements = (r.trustedSourceEndorsements || []).map(e => e.sourceName).join(", ");
      return `- ${r.name} (${r.neighborhood}, ${(r.cuisine||[]).join("/")}, ${"$".repeat(r.priceRange||2)})${src}${endorsements ? ` [endorsed by: ${endorsements}]` : ""}`;
    }).join("\n");

    const sourcesList = sources.map(s => `- ${s.name} (${s.type})${s.notes ? `: ${s.notes}` : ""}`).join("\n");

    const systemPrompt = `You are Table, a personal dining concierge for Matt and Denise in Manhattan. You know their taste deeply.

MATT'S PREFERENCES:
General tastes: ${mattPrefs.generalTastes || "Not specified"}
Current cravings: ${mattPrefs.currentCravings || "Not specified"}
Dealbreakers: ${mattPrefs.dealbreakers || "Not specified"}

DENISE'S PREFERENCES:
General tastes: ${denisePrefs.generalTastes || "Not specified"}
Current cravings: ${denisePrefs.currentCravings || "Not specified"}
Dealbreakers: ${denisePrefs.dealbreakers || "Not specified"}

RESTAURANTS THEY'VE VISITED:
${visitedSummary || "None yet."}

RESTAURANTS ON THEIR WISHLIST:
${wishlistSummary || "None yet."}

THEIR TRUSTED SOURCES:
${sourcesList || "None configured."}

YOUR TASK:
Based on the user's request, recommend exactly 3 Manhattan restaurants. For each:
1. Restaurant name
2. Cuisine and neighborhood
3. Price range ($ to $$$$)
4. A short, warm reason why this is a great pick for them specifically (reference their preferences, past visits, or trusted sources when relevant)
5. Whether it's from their wishlist, a past favorite, or a new suggestion

Respond in valid JSON with this exact structure:
{
  "recommendations": [
    {
      "rank": 1,
      "name": "Restaurant Name",
      "cuisine": "Cuisine Type",
      "neighborhood": "Neighborhood",
      "priceRange": 3,
      "reasoning": "Why this is perfect for you...",
      "source": "wishlist" | "favorite" | "new",
      "trustedSourceMentions": ["source name if any"]
    }
  ],
  "conciergeNote": "A brief, warm one-liner about the recommendations as a group"
}

Be opinionated. Be specific. Reference their actual history and preferences. If they haven't logged enough data yet, make smart recommendations for Manhattan and say so. Never recommend chains or tourist traps.`;

    const client = new Anthropic({ apiKey: CLAUDE_API_KEY.value() });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: query }],
    });

    const responseText = message.content[0].text;

    // Parse JSON from response (handle potential markdown wrapping)
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch {
      parsed = { recommendations: [], conciergeNote: responseText };
    }

    return res.status(200).json(parsed);
  } catch (e) {
    console.error("Concierge error:", e);
    return res.status(500).json({ error: "Concierge error", detail: e.message });
  }
});

// ============ RESY AVAILABILITY ============
exports.resyAvailability = onRequest({ cors: false }, async (req, res) => {
  if (handleCors(req, res)) return;
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { name, neighborhood, day, partySize } = req.body;
  if (!name || !day) return res.status(400).json({ error: "Missing name or day" });

  const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";
  const headers = {
    "Authorization": `ResyAPI api_key="${RESY_API_KEY}"`,
    "Origin": "https://resy.com",
    "Referer": "https://resy.com/",
  };

  try {
    // Step 1: Search for the venue to get venue_id
    const searchQ = encodeURIComponent(name);
    const loc = encodeURIComponent(neighborhood ? `${neighborhood}, New York, NY` : "New York, NY");
    const searchUrl = `https://api.resy.com/3/venuesearch/search?query=${searchQ}&geo={"latitude":40.7128,"longitude":-74.0060}&per_page=5&types=["venue"]`;

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    const venues = searchData?.search?.hits || [];
    if (venues.length === 0) {
      return res.status(200).json({ found: false, message: "Restaurant not found on Resy" });
    }

    // Best match — first result
    const venue = venues[0];
    const venueId = venue.id?.resy;
    const venueName = venue.name;
    const venueSlug = venue.url_slug;

    if (!venueId) {
      return res.status(200).json({ found: false, message: "No Resy venue ID found" });
    }

    // Step 2: Get availability for that venue
    const size = partySize || 2;
    const findUrl = `https://api.resy.com/4/find?lat=40.7128&long=-74.0060&day=${day}&party_size=${size}&venue_id=${venueId}`;

    const findRes = await fetch(findUrl, { headers });
    const findData = await findRes.json();

    const venueData = findData?.results?.venues?.[0];
    if (!venueData || !venueData.slots || venueData.slots.length === 0) {
      return res.status(200).json({
        found: true,
        venueId,
        venueName,
        venueSlug,
        available: false,
        message: "No availability for this date/party size",
      });
    }

    // Parse slots
    const slots = venueData.slots.map(slot => ({
      time: slot.date?.start,
      type: slot.config?.type || "Dining Room",
      token: slot.config?.token,
    })).filter(s => s.time);

    return res.status(200).json({
      found: true,
      venueId,
      venueName,
      venueSlug,
      available: true,
      slots,
      resyUrl: `https://resy.com/cities/ny/${venueSlug}`,
    });
  } catch (e) {
    console.error("Resy error:", e);
    return res.status(500).json({ error: "Resy lookup error", detail: e.message });
  }
});

// ============ YELP ENRICHMENT ============
exports.yelpEnrich = onRequest({ cors: false, secrets: ["YELP_API_KEY"] }, async (req, res) => {
  if (handleCors(req, res)) return;
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { name, neighborhood } = req.body;
  if (!name) return res.status(400).json({ error: "Missing restaurant name" });

  try {
    const searchTerm = encodeURIComponent(name);
    const location = encodeURIComponent(neighborhood ? `${neighborhood}, Manhattan, NYC` : "Manhattan, NYC");
    const url = `https://api.yelp.com/v3/businesses/search?term=${searchTerm}&location=${location}&categories=restaurants&limit=3`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${YELP_API_KEY.value()}` },
    });
    const data = await response.json();

    if (!data.businesses || data.businesses.length === 0) {
      return res.status(200).json({ found: false });
    }

    // Return the best match
    const biz = data.businesses[0];
    return res.status(200).json({
      found: true,
      yelp: {
        name: biz.name,
        rating: biz.rating,
        reviewCount: biz.review_count,
        price: biz.price,
        categories: (biz.categories || []).map(c => c.title),
        address: biz.location?.display_address?.join(", ") || "",
        neighborhood: biz.location?.neighborhood || biz.location?.city || "",
        phone: biz.phone,
        url: biz.url,
        imageUrl: biz.image_url,
        coordinates: biz.coordinates,
      },
    });
  } catch (e) {
    console.error("Yelp error:", e);
    return res.status(500).json({ error: "Yelp enrichment error", detail: e.message });
  }
});

// ============ YELP SEARCH (for discovery) ============
exports.yelpSearch = onRequest({ cors: false, secrets: ["YELP_API_KEY"] }, async (req, res) => {
  if (handleCors(req, res)) return;
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { query, neighborhood, cuisine, price } = req.body;
  const params = new URLSearchParams({
    term: query || "restaurant",
    location: neighborhood ? `${neighborhood}, Manhattan, NYC` : "Manhattan, NYC",
    categories: "restaurants",
    limit: "10",
    sort_by: "rating",
  });
  if (price) params.append("price", price); // 1-4

  try {
    const response = await fetch(`https://api.yelp.com/v3/businesses/search?${params}`, {
      headers: { Authorization: `Bearer ${YELP_API_KEY.value()}` },
    });
    const data = await response.json();
    const results = (data.businesses || []).map(biz => ({
      name: biz.name,
      rating: biz.rating,
      reviewCount: biz.review_count,
      price: biz.price,
      categories: (biz.categories || []).map(c => c.title),
      neighborhood: biz.location?.city || "",
      address: biz.location?.display_address?.join(", ") || "",
      url: biz.url,
    }));
    return res.status(200).json({ results });
  } catch (e) {
    console.error("Yelp search error:", e);
    return res.status(500).json({ error: "Search error" });
  }
});

// ============ FOR YOU LIST REFRESH ============
exports.refreshForYou = onRequest({ cors: false, secrets: ["CLAUDE_API_KEY"] }, async (req, res) => {
  if (handleCors(req, res)) return;
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Load all data
    const [restaurantsSnap, mattPref, denisePref, sourcesSnap] = await Promise.all([
      db.collection("restaurants").get(),
      db.doc("preferences/matt").get(),
      db.doc("preferences/denise").get(),
      db.collection("trustedSources").get(),
    ]);

    const restaurants = restaurantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const mattPrefs = mattPref.exists ? mattPref.data() : {};
    const denisePrefs = denisePref.exists ? denisePref.data() : {};
    const sources = sourcesSnap.docs.map(d => d.data());

    const visited = restaurants.filter(r => r.visits && r.visits.length > 0);
    const wishlist = restaurants.filter(r => r.status === "wishlist" || r.status === "recommended");

    const context = `MATT: ${mattPrefs.generalTastes || "No preferences"}, craving: ${mattPrefs.currentCravings || "nothing specific"}, avoid: ${mattPrefs.dealbreakers || "nothing"}
DENISE: ${denisePrefs.generalTastes || "No preferences"}, craving: ${denisePrefs.currentCravings || "nothing specific"}, avoid: ${denisePrefs.dealbreakers || "nothing"}
VISITED (${visited.length}): ${visited.map(r => `${r.name}(M:${r.mattRating||0}/D:${r.deniseRating||0})`).join(", ")}
WISHLIST (${wishlist.length}): ${wishlist.map(r => r.name).join(", ")}
TRUSTED SOURCES: ${sources.map(s => s.name).join(", ") || "None"}`;

    const client = new Anthropic({ apiKey: CLAUDE_API_KEY.value() });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: `You are Table, a dining concierge for Matt and Denise in Manhattan. Generate a "For You" list of 15 restaurant recommendations. Mix their wishlist picks, restaurants similar to their favorites, and exciting new options.

For each, provide: name, cuisine, neighborhood, price range (1-4), and a short reason.

IMPORTANT: Include restaurants from their wishlist when they match current cravings. Prioritize restaurants endorsed by their trusted sources.

Respond in valid JSON:
{
  "forYou": [
    { "name": "...", "cuisine": "...", "neighborhood": "...", "priceRange": 2, "reasoning": "...", "source": "wishlist|similar|new|trusted" }
  ]
}`,
      messages: [{ role: "user", content: `Refresh my For You list. Here's my current data:\n${context}` }],
    });

    const responseText = message.content[0].text;
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch {
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Save to Firestore
    const batch = db.batch();
    // Clear existing
    const existingSnap = await db.collection("forYouList").get();
    existingSnap.docs.forEach(d => batch.delete(d.ref));

    // Add new
    (parsed.forYou || []).forEach((item, i) => {
      const ref = db.collection("forYouList").doc();
      batch.set(ref, {
        ...item,
        score: 100 - i,
        status: "active",
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    return res.status(200).json({ success: true, count: (parsed.forYou || []).length });
  } catch (e) {
    console.error("Refresh error:", e);
    return res.status(500).json({ error: "Refresh error", detail: e.message });
  }
});
