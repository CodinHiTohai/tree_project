const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  // Don't exit — keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for all non-API routes (SPA fallback)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ✅ SIMPLE JSON DATABASE (No ESM issues like lowdb v5)
// ============================================================
// On Render (production), use /tmp for writable storage; locally use project dir
const dbPath = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'db.json')
  : path.join(__dirname, 'db.json');

// In-memory fallback if file system is not writable
let memoryDB = null;

function readDB() {
  // If memoryDB is set, use it (file write failed previously)
  if (memoryDB !== null) return memoryDB;
  try {
    if (!fs.existsSync(dbPath)) {
      const defaultData = { trees: [], watering_events: [] };
      try {
        fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2));
      } catch (writeErr) {
        console.warn('⚠️ Cannot write to', dbPath, '- switching to memory mode');
        memoryDB = defaultData;
        return defaultData;
      }
      return defaultData;
    }
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.trees) data.trees = [];
    if (!data.watering_events) data.watering_events = [];
    return data;
  } catch (err) {
    console.error('❌ DB read error:', err);
    if (!memoryDB) memoryDB = { trees: [], watering_events: [] };
    return memoryDB;
  }
}

function writeDB(data) {
  if (memoryDB !== null) {
    // Memory mode - just update the in-memory object
    memoryDB = data;
    return;
  }
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ DB write error:', err.message, '- switching to memory mode');
    memoryDB = data;
  }
}

// Initialize DB
try {
  const initialData = readDB();
  console.log(`📂 Database loaded: ${initialData.trees.length} trees, ${initialData.watering_events.length} events`);
  console.log(`📂 DB path: ${dbPath}, Memory mode: ${memoryDB !== null}`);
} catch (startupErr) {
  console.error('❌ DB startup error:', startupErr.message);
  memoryDB = { trees: [], watering_events: [] };
}

// Multer setup — use a temp name first, rename after with tree ID
// On Render production, uploads also go to /tmp
const uploadDir = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${req.params.id || 'unknown'}_${Date.now()}${ext}`;
    cb(null, filename);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only JPEG, PNG, WebP allowed.'));
  },
});

// Generate event ID
function generateEventId() {
  return uuidv4();
}

// ============================================================
// 🌿 REAL SOIL MOISTURE ANALYSIS
// Uses pixel-level color analysis for accurate wet/dry detection
// 
// WET SOIL characteristics:
//   - Darker overall (lower brightness)
//   - More saturated colors
//   - Blue/dark brown tones
//   - Reflective/shiny patches (water)
//
// DRY SOIL characteristics:
//   - Lighter, washed out
//   - Sandy/light brown/yellowish tones
//   - High brightness
//   - Less color saturation
// ============================================================

async function analyzeSoilMoisture(imagePath) {
  try {
    let sharp;
    try {
      sharp = require('sharp');
      // Quick test to ensure sharp actually works (native binaries OK)
      await sharp(imagePath).metadata();
    } catch (e) {
      console.log('⚠️ Sharp not available, using byte analysis:', e.message);
      return analyzeSoilMoistureBasic(imagePath);
    }

    // Use sharp to decode the image to raw pixel data (RGB)
    const { data: pixels, info } = await sharp(imagePath)
      .resize(200, 200, { fit: 'cover' }) // Resize for consistent analysis
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const totalPixels = info.width * info.height;
    
    let totalBrightness = 0;
    let darkPixelCount = 0;     // brightness < 80
    let veryDarkCount = 0;      // brightness < 50
    let lightPixelCount = 0;    // brightness > 170
    let veryLightCount = 0;     // brightness > 200
    let brownPixelCount = 0;    // typical dry soil color
    let wetBrownCount = 0;      // dark brown (wet soil)
    let greenPixelCount = 0;    // green (leaves/grass, not soil)
    let blueishCount = 0;       // blue tones (water reflection)
    let sandyCount = 0;         // sandy/yellow tones (very dry)
    let totalSaturation = 0;
    let highSatCount = 0;

    for (let i = 0; i < pixels.length; i += 3) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      
      const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
      totalBrightness += brightness;
      
      // Brightness buckets
      if (brightness < 50) veryDarkCount++;
      if (brightness < 80) darkPixelCount++;
      if (brightness > 170) lightPixelCount++;
      if (brightness > 200) veryLightCount++;
      
      // Calculate saturation (HSL)
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let s = 0;
      if (max !== min) {
        s = l > 127 ? (max - min) / (510 - max - min) : (max - min) / (max + min);
      }
      totalSaturation += s;
      if (s > 0.3) highSatCount++;
      
      // Color classification
      // Dry brown/sandy: R > G > B, high brightness
      if (r > 120 && g > 90 && b < g && r > b * 1.3 && brightness > 100) {
        brownPixelCount++;
      }
      // Sandy/yellow (very dry): high R and G, low B
      if (r > 150 && g > 130 && b < 100 && brightness > 130) {
        sandyCount++;
      }
      // Wet/dark brown: low brightness, R slightly > G > B
      if (brightness < 100 && r > b && g > b && r < 150) {
        wetBrownCount++;
      }
      // Green detection (grass/leaves)
      if (g > r * 1.1 && g > b * 1.2 && g > 60) {
        greenPixelCount++;
      }
      // Blue-ish (water reflection)
      if (b > r * 0.9 && b > g * 0.9 && b > 50) {
        blueishCount++;
      }
    }

    const avgBrightness = totalBrightness / totalPixels;
    const avgSaturation = totalSaturation / totalPixels;
    const darkRatio = darkPixelCount / totalPixels;
    const veryDarkRatio = veryDarkCount / totalPixels;
    const lightRatio = lightPixelCount / totalPixels;
    const veryLightRatio = veryLightCount / totalPixels;
    const brownRatio = brownPixelCount / totalPixels;
    const wetBrownRatio = wetBrownCount / totalPixels;
    const sandyRatio = sandyCount / totalPixels;
    const greenRatio = greenPixelCount / totalPixels;
    const blueRatio = blueishCount / totalPixels;

    // ---- SCORING SYSTEM ----
    // Positive score = WET, Negative score = DRY
    let wetScore = 0;

    // 1. Average brightness (most important for soil)
    if (avgBrightness < 60) wetScore += 30;
    else if (avgBrightness < 80) wetScore += 22;
    else if (avgBrightness < 100) wetScore += 12;
    else if (avgBrightness < 120) wetScore += 0;
    else if (avgBrightness < 140) wetScore -= 10;
    else if (avgBrightness < 160) wetScore -= 20;
    else wetScore -= 30; // Very bright = definitely dry

    // 2. Dark pixel ratio
    if (darkRatio > 0.5) wetScore += 20;
    else if (darkRatio > 0.35) wetScore += 12;
    else if (darkRatio > 0.2) wetScore += 5;
    else wetScore -= 10;

    // 3. Very dark pixels (strong wet indicator)
    if (veryDarkRatio > 0.3) wetScore += 15;
    else if (veryDarkRatio > 0.15) wetScore += 8;

    // 4. Light pixels penalty (dry indicator)
    if (veryLightRatio > 0.3) wetScore -= 25;
    else if (lightRatio > 0.4) wetScore -= 15;
    else if (lightRatio > 0.25) wetScore -= 8;

    // 5. Sandy/dry brown detection (STRONG dry indicator)
    if (sandyRatio > 0.25) wetScore -= 25;
    else if (sandyRatio > 0.15) wetScore -= 15;
    else if (sandyRatio > 0.08) wetScore -= 8;

    // 6. Dry brown general
    if (brownRatio > 0.35) wetScore -= 20;
    else if (brownRatio > 0.2) wetScore -= 10;

    // 7. Wet brown (dark moist soil)
    if (wetBrownRatio > 0.4) wetScore += 18;
    else if (wetBrownRatio > 0.25) wetScore += 10;
    else if (wetBrownRatio > 0.15) wetScore += 5;

    // 8. Blue tones (water reflection)
    if (blueRatio > 0.2) wetScore += 12;
    else if (blueRatio > 0.1) wetScore += 6;

    // 9. Saturation analysis
    // Wet soil tends to have slightly higher saturation
    if (avgSaturation > 0.25) wetScore += 5;
    else if (avgSaturation < 0.1) wetScore -= 5;

    // 10. Too much green = photo of leaves/grass, not soil
    if (greenRatio > 0.4) {
      wetScore -= 15; // Penalize: probably not soil photo
    }

    // ---- DECISION ----
    // Strict threshold: wetScore must be >= 30 for WET
    // This ensures dry photos are properly rejected
    const isWet = wetScore >= 30;

    // Calculate confidence
    let confidence;
    if (isWet) {
      confidence = Math.min(95, 55 + Math.floor(wetScore * 0.8));
    } else {
      confidence = Math.min(95, 55 + Math.floor(Math.abs(wetScore) * 0.8));
    }
    confidence = Math.max(50, confidence);

    const status = isWet ? 'wet' : 'dry';

    console.log(`📸 PIXEL Analysis [${info.width}x${info.height}]:`);
    console.log(`   Brightness: avg=${avgBrightness.toFixed(1)}, dark=${(darkRatio*100).toFixed(1)}%, light=${(lightRatio*100).toFixed(1)}%`);
    console.log(`   Colors: brown=${(brownRatio*100).toFixed(1)}%, sandy=${(sandyRatio*100).toFixed(1)}%, wetBrown=${(wetBrownRatio*100).toFixed(1)}%`);
    console.log(`   blue=${(blueRatio*100).toFixed(1)}%, green=${(greenRatio*100).toFixed(1)}%, sat=${(avgSaturation*100).toFixed(1)}%`);
    console.log(`   WetScore: ${wetScore}, Result: ${status.toUpperCase()}, Confidence: ${confidence}%`);

    const reason = isWet
      ? `Zameen bheegi hai (darkness: ${(darkRatio * 100).toFixed(0)}%, brightness: ${avgBrightness.toFixed(0)})`
      : `Zameen sukhi hai (brightness: ${avgBrightness.toFixed(0)}, sandy: ${(sandyRatio * 100).toFixed(0)}%, light pixels: ${(lightRatio * 100).toFixed(0)}%)`;

    return { status, confidence, reason, wetScore };

  } catch (err) {
    console.error('❌ Soil analysis error:', err);
    // On error, default to DRY (safe — don't give false positive)
    return { status: 'dry', confidence: 50, reason: 'Image analysis mein error aayi — safe mode: dry', wetScore: 0 };
  }
}

// Fallback basic analysis (without sharp)
function analyzeSoilMoistureBasic(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const fileBytes = new Uint8Array(imageBuffer);
    const totalBytes = fileBytes.length;

    // Extended analysis on raw bytes
    const sampleSize = Math.min(totalBytes, 100000);
    const step = Math.max(1, Math.floor(totalBytes / sampleSize));

    let darkCount = 0, lightCount = 0, totalSampled = 0, sumValues = 0;
    let warmCount = 0, coolCount = 0;

    // Skip headers
    const startOffset = Math.min(500, Math.floor(totalBytes * 0.15));

    for (let i = startOffset; i < totalBytes - 2; i += step * 3) {
      const v1 = fileBytes[i];
      const v2 = fileBytes[i + 1] || 0;
      const v3 = fileBytes[i + 2] || 0;

      const avg = (v1 + v2 + v3) / 3;
      sumValues += avg;
      totalSampled++;

      if (avg < 80) darkCount++;
      else if (avg > 170) lightCount++;

      // Warm (dry) vs cool (wet) tone estimation
      if (v1 > v3 * 1.2 && v2 > v3) warmCount++;
      if (v3 > v1 * 0.9 && v3 > v2 * 0.9) coolCount++;
    }

    if (totalSampled === 0) {
      return { status: 'dry', confidence: 50, reason: 'Image analyze nahi ho payi', wetScore: 0 };
    }

    const avgBrightness = sumValues / totalSampled;
    const darkRatio = darkCount / totalSampled;
    const lightRatio = lightCount / totalSampled;
    const warmRatio = warmCount / totalSampled;
    const coolRatio = coolCount / totalSampled;

    let wetScore = 0;

    // Brightness
    if (avgBrightness < 90) wetScore += 25;
    else if (avgBrightness < 110) wetScore += 15;
    else if (avgBrightness < 130) wetScore += 5;
    else if (avgBrightness < 150) wetScore -= 5;
    else wetScore -= 15;

    // Dark pixels
    if (darkRatio > 0.35) wetScore += 20;
    else if (darkRatio > 0.2) wetScore += 10;
    else wetScore -= 5;

    // Light pixels
    if (lightRatio > 0.4) wetScore -= 20;
    else if (lightRatio > 0.25) wetScore -= 10;

    // Warm/cool tones
    if (warmRatio > 0.3) wetScore -= 10;
    if (coolRatio > 0.15) wetScore += 10;

    // STRICTER threshold for basic analysis (less reliable)
    const isWet = wetScore >= 35;

    let confidence = isWet
      ? Math.min(85, 50 + wetScore)
      : Math.min(85, 50 + Math.abs(wetScore));
    confidence = Math.max(50, confidence);

    const status = isWet ? 'wet' : 'dry';
    const reason = isWet
      ? `Zameen bheegi lag rahi hai (darkness: ${(darkRatio * 100).toFixed(0)}%, brightness: ${avgBrightness.toFixed(0)})`
      : `Zameen sukhi lag rahi hai (brightness: ${avgBrightness.toFixed(0)}, light: ${(lightRatio * 100).toFixed(0)}%)`;

    console.log(`📸 BASIC Analysis: wetScore=${wetScore}, brightness=${avgBrightness.toFixed(0)}, dark=${(darkRatio*100).toFixed(1)}%, Result: ${status}`);

    return { status, confidence, reason, wetScore };

  } catch (err) {
    console.error('❌ Basic soil analysis error:', err);
    return { status: 'dry', confidence: 50, reason: 'Analysis error — safe mode: dry', wetScore: 0 };
  }
}


// ============================================================
// API ROUTES
// ============================================================

// List all trees
app.get('/api/trees', (req, res) => {
  try {
    const db = readDB();
    res.json(db.trees || []);
  } catch (err) {
    console.error('GET /api/trees error:', err);
    res.status(500).json({ error: 'Failed to load trees' });
  }
});

// ✅ Register tree — FIXED (no more lowdb ESM issues)
app.post('/api/trees', (req, res) => {
  try {
    console.log('📥 Register tree request body:', JSON.stringify(req.body));

    const { species, latitude, longitude } = req.body;

    // Validate latitude and longitude
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng)) {
      console.log('❌ Invalid coordinates:', { latitude, longitude });
      return res.status(400).json({ error: 'Latitude aur Longitude sahi se daalo' });
    }

    if (lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'Latitude -90 se 90 ke beech hona chahiye' });
    }

    if (lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Longitude -180 se 180 ke beech hona chahiye' });
    }

    const id = uuidv4();

    const newTree = {
      id,
      species: species || 'Unknown',
      latitude: lat,
      longitude: lng,
      created_at: new Date().toISOString()
    };

    const db = readDB();
    db.trees.push(newTree);
    writeDB(db);

    console.log(`✅ Tree registered: ${id} (${newTree.species}) at ${lat}, ${lng}`);
    res.json({ treeId: id });
  } catch (err) {
    console.error('POST /api/trees error:', err);
    res.status(500).json({ error: 'Tree register nahi ho paya: ' + err.message });
  }
});

// Get tree details
app.get('/api/trees/:id', (req, res) => {
  try {
    const db = readDB();
    const tree = db.trees.find(t => t.id === req.params.id);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    res.json(tree);
  } catch (err) {
    console.error('GET /api/trees/:id error:', err);
    res.status(500).json({ error: 'Failed to get tree details' });
  }
});

// ✅ Upload soil image — REAL IMAGE ANALYSIS
// Dry photos REJECTED! Only wet soil = watering confirmed
app.post('/api/trees/:id/soil', upload.single('soilImage'), async (req, res) => {
  try {
    const treeId = req.params.id;
    const db = readDB();

    const tree = db.trees.find(t => t.id === treeId);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });

    if (!req.file) {
      return res.status(400).json({ error: 'Image required' });
    }

    console.log(`📷 Analyzing soil image for tree: ${treeId} (file: ${req.file.filename})`);

    // ✅ REAL image analysis
    const imagePath = path.join(uploadDir, req.file.filename);
    const analysis = await analyzeSoilMoisture(imagePath);

    const eventId = generateEventId();

    const newEvent = {
      id: eventId,
      tree_id: treeId,  // ✅ STRICTLY tied to this specific tree
      timestamp: new Date().toISOString(),
      status: analysis.status,
      confidence: analysis.confidence,
      image_path: req.file.filename,
      reason: analysis.reason,
      wet_score: analysis.wetScore
    };

    db.watering_events.push(newEvent);
    writeDB(db);

    console.log(`📸 Result for tree ${treeId}: ${analysis.status} (score: ${analysis.wetScore}, confidence: ${analysis.confidence}%)`);

    res.json({
      status: analysis.status,
      confidence: analysis.confidence,
      reason: analysis.reason,
      imageUrl: `/uploads/${req.file.filename}`
    });
  } catch (err) {
    console.error('POST /api/trees/:id/soil error:', err);
    res.status(500).json({ error: 'Failed to analyze soil: ' + err.message });
  }
});

// Get watering history
app.get('/api/trees/:id/history', (req, res) => {
  try {
    const db = readDB();
    const history = (db.watering_events || [])
      .filter(e => e.tree_id === req.params.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(history);
  } catch (err) {
    console.error('GET /api/trees/:id/history error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// Get latest watering event for a tree
app.get('/api/trees/:id/latest', (req, res) => {
  try {
    const db = readDB();
    const events = (db.watering_events || [])
      .filter(e => e.tree_id === req.params.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (events.length === 0) return res.json(null);
    res.json(events[0]);
  } catch (err) {
    console.error('GET /api/trees/:id/latest error:', err);
    res.status(500).json({ error: 'Failed to load latest event' });
  }
});

// ✅ Mark water given — ONLY allowed after wet soil proof FOR THIS SPECIFIC TREE
app.post('/api/trees/:id/watered', (req, res) => {
  try {
    const db = readDB();
    const treeId = req.params.id;
    const tree = db.trees.find(t => t.id === treeId);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });

    // ✅ Check if there's a recent wet soil proof for THIS SPECIFIC tree
    const recentEvents = (db.watering_events || [])
      .filter(e => e.tree_id === treeId && e.status === 'wet')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Must have a wet soil proof within the last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const hasRecentProof = recentEvents.length > 0 &&
      new Date(recentEvents[0].timestamp) > tenMinutesAgo;

    if (!hasRecentProof) {
      console.log(`❌ Watering rejected for tree ${treeId}: No recent wet soil proof`);
      return res.status(400).json({
        error: 'Pehle bheegi zameen ki photo upload karo! Bina proof ke pani record nahi hoga.',
        needsProof: true
      });
    }

    const eventId = generateEventId();
    const newEvent = {
      id: eventId,
      tree_id: treeId,  // ✅ Strictly this tree only
      timestamp: new Date().toISOString(),
      status: 'watered',
      confidence: 100,
      image_path: null
    };

    db.watering_events.push(newEvent);
    writeDB(db);

    console.log(`✅ Watering recorded for tree ${treeId} (event: ${eventId})`);
    res.json({ success: true, eventId });
  } catch (err) {
    console.error('POST /api/trees/:id/watered error:', err);
    res.status(500).json({ error: 'Failed to record watering' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📂 Database path: ${dbPath}`);
  console.log(`📁 Upload dir: ${uploadDir}`);
});