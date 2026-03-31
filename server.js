const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
const MAX_FREE_IMAGES = 5;

// In-memory IP tracker (use a database in production)
const ipUsage = {};

// Check usage by IP
app.get('/api/usage', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const used = ipUsage[ip] || 0;
  res.json({ used, limit: MAX_FREE_IMAGES, remaining: Math.max(0, MAX_FREE_IMAGES - used) });
});

// Generate image
app.post('/api/generate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const used = ipUsage[ip] || 0;
  const isPro = req.headers['x-pro-user'] === 'true';

  if (!isPro && used >= MAX_FREE_IMAGES) {
    return res.status(403).json({ error: 'Free limit reached. Please upgrade to Pro.' });
  }

  const { prompt, aspectRatio, style, quality, lighting } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  // Aspect ratio to width/height
  const arMap = {
    '1:1': { width: 1024, height: 1024 },
    '16:9': { width: 1366, height: 768 },
    '9:16': { width: 768, height: 1366 },
    '4:3': { width: 1024, height: 768 },
    '3:4': { width: 768, height: 1024 },
    '21:9': { width: 1536, height: 640 },
    '2:3': { width: 683, height: 1024 },
  };
  const dims = arMap[aspectRatio] || { width: 1024, height: 1024 };

  const qualityMap = {
    standard: 20,
    high: 28,
    ultra: 35,
  };
  const steps = qualityMap[quality] || 28;

  const enhancedPrompt = `${prompt}, style: ${style}, lighting: ${lighting}, masterpiece, best quality, sharp focus, highly detailed, 8K`;

  try {
    // Start prediction
    const startRes = await axios.post(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
      {
        input: {
          prompt: enhancedPrompt,
          width: dims.width,
          height: dims.height,
          num_inference_steps: steps,
          num_outputs: 1,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${REPLICATE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const predictionId = startRes.data.id;

    // Poll for result
    let imageUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await axios.get(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` } }
      );
      if (pollRes.data.status === 'succeeded') {
        imageUrl = pollRes.data.output?.[0];
        break;
      }
      if (pollRes.data.status === 'failed') {
        return res.status(500).json({ error: 'Image generation failed' });
      }
    }

    if (!imageUrl) return res.status(500).json({ error: 'Timeout. Try again.' });

    // Increment usage
    if (!isPro) {
      ipUsage[ip] = used + 1;
    }

    res.json({ imageUrl, used: isPro ? 0 : used + 1 });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pixlora backend running on port ${PORT}`));
