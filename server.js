import express from 'express'
import multer from 'multer'
import Groq from 'groq-sdk'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'
config({ path: new URL('.env', import.meta.url).pathname })

const __dirname = dirname(fileURLToPath(import.meta.url))

const app    = express()
const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

// ── Image upload ────────────────────────────────────────────────────────────
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_TYPES.includes(file.mimetype))
  },
})

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public'), { etag: false, maxAge: 0 }))
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// ── Recipe variety pools (cuisine-aware) ─────────────────────────────────────
const STYLE_POOLS = {
  Italian: [
    'a pasta dish (e.g. aglio e olio, primavera, or a creamy sauce pasta)',
    'a risotto',
    'a frittata or baked egg dish',
    'a tray-baked or roasted Italian dish',
    'a bruschetta, flatbread, or pizza-style dish',
    'stuffed vegetables Italian-style (e.g. ripieni)',
    'a minestrone or Italian vegetable soup',
    'a light Italian salad or panzanella',
  ],
  Mexican: [
    'tacos, burritos, or quesadillas',
    'enchiladas or tostadas',
    'a Mexican rice bowl',
    'stuffed peppers (chile relleno style)',
    'a soup or pozole',
    'huevos rancheros or a Mexican egg dish',
    'a Mexican-style grain or bean bowl',
  ],
  Indian: [
    'a curry or sabzi (dry or gravy)',
    'a dal dish',
    'a rice dish (pulao, biryani, or khichdi)',
    'a stuffed paratha or flatbread with filling',
    'a raita bowl with roasted vegetables',
    'a soup or rasam',
    'a chaat-style snack plate',
    'an egg-based dish (egg curry, bhurji, or masala omelette)',
  ],
  'South Indian': [
    'a sambar with rice or idli',
    'a kootu or dry stir-fry (poriyal)',
    'a rasam or pepper soup',
    'a rice dish (lemon rice, coconut rice, or curd rice)',
    'uthappam or dosa with a filling',
    'an aviyal (mixed vegetable coconut dish)',
    'a pachadi or raita-style side with rice',
    'an upma or rava-based savoury dish',
  ],
  Asian: [
    'a stir-fry with a thick umami sauce (oyster, hoisin, or black bean)',
    'fried rice or noodles',
    'a congee or savoury rice porridge',
    'a dumpling or steamed bun filling',
    'a teriyaki-glazed dish',
    'a miso soup or Asian broth',
    'a Korean-style bibimbap bowl',
    'a Thai-style curry or coconut broth',
  ],
  Mediterranean: [
    'a shakshuka or baked egg dish',
    'a mezze plate with roasted vegetables',
    'a grain bowl (farro, bulgur, or couscous)',
    'stuffed vegetables Mediterranean-style',
    'a Greek salad or fattoush',
    'a hummus-based bowl with toppings',
    'a roasted vegetable tart or galette',
    'a soup or lentil dish',
  ],
  American: [
    'a loaded bowl or burrito bowl',
    'a mac & cheese or cheesy bake',
    'a breakfast hash',
    'a grilled or pan-seared main with roasted sides',
    'a hearty salad with croutons',
    'a slider, patty, or sandwich',
    'a casserole or one-pan bake',
  ],
  Any: [
    'a curry or gravy-based dish',
    'a rice dish (pulao, fried rice, or grain bowl)',
    'a noodle or pasta dish',
    'an egg-based dish (frittata, shakshuka, or egg curry)',
    'a stuffed or rolled dish (wraps, stuffed peppers, or rolls)',
    'a roasted or oven-baked dish',
    'a fresh salad or grain bowl',
    'a patty, cutlet, or fritter',
    'a soup or comforting stew',
    'a breakfast-for-dinner dish',
    'a creamy gratin or bake',
    'a sautéed dish with a bold sauce',
  ],
}

function pickStyle (cuisine) {
  const pool = STYLE_POOLS[cuisine] ?? STYLE_POOLS['Any']
  return pool[Math.floor(Math.random() * pool.length)]
}

// ── Identify ingredients endpoint (fast, no SSE) ─────────────────────────────
app.post('/api/identify', upload.array('images', 4), async (req, res) => {
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: 'No images provided.' })

  const imageBlocks = files.map(f => ({
    type: 'image_url',
    image_url: { url: `data:${f.mimetype};base64,${f.buffer.toString('base64')}` },
  }))

  try {
    const response = await client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 120,
      messages: [
        {
          role: 'system',
          content: 'You are a fridge scanner. Look at the photo(s) and output ONLY a plain comma-separated list of visible food ingredients. No intro, no explanation, no extra text — just the list. Example: eggs, cheddar cheese, bell peppers, milk, carrots',
        },
        {
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: 'List every food ingredient you can see.' },
          ],
        },
      ],
    })
    const raw = response.choices[0]?.message?.content || ''
    const ingredients = raw.split(',').map(s => s.trim().replace(/^[-•*]\s*/, '')).filter(Boolean)
    console.log(`POST /api/identify — ${files.length} image(s) → ${ingredients.length} ingredients`)
    res.json({ ingredients })
  } catch (err) {
    console.error('Identify error:', err)
    res.status(500).json({ error: err.message ?? 'Unknown error' })
  }
})

// ── Recipe endpoint (SSE stream) ─────────────────────────────────────────────
app.post('/api/recipe', upload.array('images', 4), async (req, res) => {
  const cuisine    = req.body?.cuisine    || 'Any'
  const diet       = req.body?.diet       || 'None'
  const servings   = parseInt(req.body?.servings || '2', 10)
  const pantry     = req.body?.pantry     || ''
  const difficulty = req.body?.difficulty || 'Medium'
  const timeLimit  = req.body?.timeLimit  || 'Any'
  const mealType   = req.body?.mealType   || 'Dinner'
  const ingredients = req.body?.ingredients || ''
  const files      = req.files || []
  const style      = pickStyle(cuisine)

  console.log(`POST /api/recipe — ${files.length} img | meal:${mealType} cuisine:${cuisine} diet:${diet} diff:${difficulty} time:${timeLimit} style:"${style}"`)

  if (files.length === 0) {
    return res.status(400).json({ error: 'No image uploaded or unsupported format.' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  // ── Build prompt context ───────────────────────────────────────────────────
  const mealLabel   = mealType === 'Any' ? 'meal' : mealType.toLowerCase()
  const mealNote    = mealType !== 'Any' && mealType !== 'Dinner'
    ? `MEAL TYPE: This is for ${mealType}. Suggest a dish appropriate for ${mealType.toLowerCase()} — adjust ingredients, portion size, and style accordingly.`
    : ''
  const cuisineNote = cuisine !== 'Any'  ? `The recipe MUST be ${cuisine} cuisine style.` : ''
  const dietNote    = diet    !== 'None' ? `The recipe MUST be strictly ${diet}.` : ''
  const servingsNote= `The recipe must serve exactly ${servings} person${servings > 1 ? 's' : ''}.`
  const pantryNote  = pantry ? `The user also has these pantry/staple items available: ${pantry}.` : ''

  const photosNote = files.length > 1
    ? `The user has shared ${files.length} photos of their fridge from different angles. Examine ALL photos carefully and combine every ingredient you can spot across all of them.`
    : ''

  const styleNote = `Today's recipe format: make ${style}. Do NOT default to a plain dry stir-fry or the most obvious dish. Be creative — consider 3 ideas and pick the most interesting one.`

  const diffNote = difficulty === 'Easy'
    ? 'DIFFICULTY — Easy: use only simple techniques (no frying, no reduction, no special equipment). Max 5 steps. Any beginner can follow this.'
    : difficulty === 'Chef'
    ? 'DIFFICULTY — Chef Mode: use advanced techniques such as proper browning (Maillard), deglazing, building a sauce from fond, tempering spices, emulsification, or reduction. Include a plating tip. Impress a dinner guest.'
    : ''

  const timeNote = timeLimit !== 'Any'
    ? `TIME LIMIT: The full recipe (prep + cook combined) MUST be completable in under ${timeLimit} minutes. Choose a dish that genuinely fits this window — no slow braises or long soaks.`
    : ''

  const ingredientNote = ingredients
    ? `The user has pre-identified and confirmed these specific fridge ingredients: ${ingredients}. Use ONLY these ingredients (plus any pantry items listed above). Do not imagine or invent other fridge ingredients.`
    : ''

  // Dynamic meal label in the output header
  const mealHeader = mealType === 'Breakfast' ? '🌅 **Breakfast:' : mealType === 'Lunch' ? '☀️ **Lunch:' : mealType === 'Snack' ? '🍿 **Snack:' : '🍳 **Tonight:'

  try {
    const imageBlocks = files.map(f => ({
      type: 'image_url',
      image_url: { url: `data:${f.mimetype};base64,${f.buffer.toString('base64')}` },
    }))

    const stream = await client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 1000,
      stream: true,
      messages: [
        {
          role: 'system',
          content: `You are FridgeBrain — a creative, cheerful ${mealLabel} recipe assistant. You always suggest something interesting and varied — never the same old dish twice.
${mealNote ? '\n' + mealNote : ''}${cuisineNote ? '\n' + cuisineNote : ''}${dietNote ? '\n' + dietNote : ''}
${servingsNote}${pantryNote ? '\n' + pantryNote : ''}${photosNote ? '\n' + photosNote : ''}
${ingredientNote ? '\n' + ingredientNote : ''}${styleNote ? '\n' + styleNote : ''}
${diffNote ? '\n' + diffNote : ''}${timeNote ? '\n' + timeNote : ''}

When shown fridge photo(s), respond in this exact format (keep it tight):

🥬 **I can see:** [comma-separated list of 5–8 visible ingredients]

---

${mealHeader} [RECIPE NAME IN CAPS]**
*[One-sentence description under 15 words]*

**Steps:**
1. [Step — max 20 words]
2. [Step — max 20 words]
3. [Step — max 20 words]
4. [Step — max 20 words]
5. [Step — max 20 words]

⏱ **[X] minutes** | Serves ${servings}

🔥 **~[X] kcal** per serving | ~[P]g protein · [C]g carbs · [F]g fat

Rules:
- Use ingredients from BOTH the fridge photo(s) AND the pantry staples list
- Only suggest what you can plausibly see in the fridge or from the pantry list
- Respect cuisine style, meal type, dietary requirements, difficulty, and time limit strictly
- If the images aren't of a fridge, say so warmly and ask for a fridge photo
- Calorie estimate should be realistic for the actual ingredients and serving size
- No extra commentary before or after`,
        },
        {
          role: 'user',
          content: [
            ...imageBlocks,
            {
              type: 'text',
              text: files.length > 1
                ? `I've shared ${files.length} photos of my fridge from different angles. What can I make for ${mealLabel} today?`
                : `What can I make for ${mealLabel} today?`,
            },
          ],
        },
      ],
    })

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content
      if (text) send({ text })
    }
    send({ done: true })

  } catch (err) {
    console.error('Groq API error:', err)
    const msg = err.status === 401
      ? 'Invalid API key — check your GROQ_API_KEY in .env'
      : `API error: ${err.message ?? 'Unknown error'}`
    send({ error: msg })
  }

  res.end()
})

// ── Tweak endpoint (SSE — modify an existing recipe) ─────────────────────────
app.post('/api/tweak', express.json(), async (req, res) => {
  const { recipe, tweak } = req.body || {}
  if (!recipe || !tweak) return res.status(400).json({ error: 'Missing recipe or tweak.' })

  console.log(`POST /api/tweak — "${tweak.slice(0, 60)}"`)

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  try {
    const stream = await client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 1000,
      stream: true,
      messages: [
        {
          role: 'system',
          content: `You are FridgeBrain. The user wants to modify their recipe.
Apply the requested tweak and output the COMPLETE revised recipe in the EXACT same format as the original (🥬 I can see, recipe name, description, Steps, time, calories).
Only change what the tweak asks for — keep everything else the same.
No extra commentary before or after.`,
        },
        {
          role: 'user',
          content: `Current recipe:\n${recipe}\n\nTweak: ${tweak}`,
        },
      ],
    })

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content
      if (text) send({ text })
    }
    send({ done: true })

  } catch (err) {
    console.error('Tweak error:', err)
    send({ error: err.message ?? 'Unknown error' })
  }
  res.end()
})

// ── Shopping list endpoint (JSON — extract have/need from recipe) ─────────────
app.post('/api/shopping', express.json(), async (req, res) => {
  const { recipe } = req.body || {}
  if (!recipe) return res.status(400).json({ error: 'Missing recipe.' })

  try {
    const response = await client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 250,
      messages: [
        {
          role: 'system',
          content: `Extract a shopping list from this recipe.
The "🥬 I can see:" line tells you what ingredients are already in the fridge.
Output ONLY valid JSON — no markdown, no extra text:
{"have": ["item1","item2"], "need": ["item3","item4"]}
- "have" = ingredients from the "I can see" line
- "need" = additional ingredients in the recipe steps NOT visible in the fridge (e.g. oil, pasta, spices)
Keep items short (1–4 words). No duplicates.`,
        },
        { role: 'user', content: recipe },
      ],
    })
    const raw = response.choices[0]?.message?.content || '{}'
    const m   = raw.match(/\{[\s\S]*\}/)
    const parsed = m ? JSON.parse(m[0]) : { have: [], need: [] }
    console.log(`POST /api/shopping — have:${parsed.have?.length} need:${parsed.need?.length}`)
    res.json(parsed)
  } catch (err) {
    console.error('Shopping error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Ingredient swap endpoint ──────────────────────────────────────────────────
app.post('/api/swap', express.json(), async (req, res) => {
  const { ingredient, context } = req.body || {}
  if (!ingredient) return res.status(400).json({ error: 'Missing ingredient.' })

  console.log(`POST /api/swap — "${ingredient}"`)
  try {
    const response = await client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `Suggest 3 ingredient substitutions. Output ONLY valid JSON — no markdown, no extra text:
{"swaps":[{"name":"substitute name","note":"short why/how note, max 8 words"}]}`,
        },
        {
          role: 'user',
          content: `Recipe context: ${context ? context.slice(0, 400) : 'not provided'}\nSwap out: ${ingredient}`,
        },
      ],
    })
    const raw = response.choices[0]?.message?.content || '{}'
    const m   = raw.match(/\{[\s\S]*\}/)
    res.json(m ? JSON.parse(m[0]) : { swaps: [] })
  } catch (err) {
    console.error('Swap error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => {
  console.log(`\n🧠 FridgeBrain → http://localhost:${PORT}\n`)
})
