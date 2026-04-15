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

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ✅ MONGODB DATABASE - PERMANENT STORAGE
// Data kabhi wipe nahi hoga, even if Render restarts!
// ============================================================

let mongoose;
let Tree, WateringEvent;
let mongoConnected = false;

// Try to connect to MongoDB
async function connectMongoDB() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  
  if (!MONGO_URI) {
    console.warn('⚠️ MONGO_URI environment variable not set! Using JSON fallback.');
    return false;
  }

  try {
    mongoose = require('mongoose');

    // Tree Schema
    const treeSchema = new mongoose.Schema({
      id: { type: String, default: () => uuidv4(), unique: true },
      species: { type: String, default: 'Unknown' },
      latitude: Number,
      longitude: Number,
      created_at: { type: Date, default: Date.now }
    });

    // Watering Event Schema
    const wateringEventSchema = new mongoose.Schema({
      id: { type: String, default: () => uuidv4(), unique: true },
      tree_id: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
      status: { type: String, enum: ['wet', 'dry', 'watered'] },
      confidence: Number,
      image_path: String,
      reason: String,
      wet_score: Number
    });

    Tree = mongoose.models.Tree || mongoose.model('Tree', treeSchema);
    WateringEvent = mongoose.models.WateringEvent || mongoose.model('WateringEvent', wateringEventSchema);

    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    mongoConnected = true;
    console.log('✅ MongoDB Atlas connected! Data is PERMANENT now.');
    return true;
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.warn('⚠️ Falling back to JSON storage (data will be lost on restart!)');
    mongoConnected = false;
    return false;
  }
}

// ============================================================
// JSON FALLBACK (used only if MongoDB not configured)
// ============================================================
const dbPath = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'db.json')
  : path.join(__dirname, 'db.json');

let memoryDB = null;

function readDB() {
  if (memoryDB !== null) return memoryDB;
  try {
    if (!fs.existsSync(dbPath)) {
      const defaultData = { trees: [], watering_events: [] };
      try {
        fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2));
      } catch (writeErr) {
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
    memoryDB = data;
    return;
  }
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ DB write error:', err.message);
    memoryDB = data;
  }
}

// ============================================================
// Upload directory setup
// ============================================================
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

// ============================================================
// SOIL MOISTURE ANALYSIS (unchanged - working fine)
// ============================================================
async function analyzeSoilMoisture(imagePath) {
  try {
    let sharp;
    try {
      sharp = require('sharp');
      await sharp(imagePath).metadata();
    } catch (e) {
      console.log('⚠️ Sharp not available, using byte analysis:', e.message);
      return analyzeSoilMoistureBasic(imagePath);
    }

    const { data: pixels, info } = await sharp(imagePath)
      .resize(200, 200, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const totalPixels = info.width * info.height;
    let totalBrightness = 0;
    let darkPixelCount = 0;
    let veryDarkCount = 0;
    let lightPixelCount = 0;
    let veryLightCount = 0;
    let brownPixelCount = 0;
    let wetBrownCount = 0;
    let greenPixelCount = 0;
    let blueishCount = 0;
    let sandyCount = 0;
    let totalSaturation = 0;

    for (let i = 0; i < pixels.length; i += 3) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
      totalBrightness += brightness;
      if (brightness < 50) veryDarkCount++;
      if (brightness < 80) darkPixelCount++;
      if (brightness > 170) lightPixelCount++;
      if (brightness > 200) veryLightCount++;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let s = 0;
      if (max !== min) {
        s = l > 127 ? (max - min) / (510 - max - min) : (max - min) / (max + min);
      }
      totalSaturation += s;
      if (r > 120 && g > 90 && b < g && r > b * 1.3 && brightness > 100) brownPixelCount++;
      if (r > 150 && g > 130 && b < 100 && brightness > 130) sandyCount++;
      if (brightness < 100 && r > b && g > b && r < 150) wetBrownCount++;
      if (g > r * 1.1 && g > b * 1.2 && g > 60) greenPixelCount++;
      if (b > r * 0.9 && b > g * 0.9 && b > 50) blueishCount++;
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

    let wetScore = 0;
    if (avgBrightness < 60) wetScore += 30;
    else if (avgBrightness < 80) wetScore += 22;
    else if (avgBrightness < 100) wetScore += 12;
    else if (avgBrightness < 120) wetScore += 0;
    else if (avgBrightness < 140) wetScore -= 10;
    else if (avgBrightness < 160) wetScore -= 20;
    else wetScore -= 30;
    if (darkRatio > 0.5) wetScore += 20;
    else if (darkRatio > 0.35) wetScore += 12;
    else if (darkRatio > 0.2) wetScore += 5;
    else wetScore -= 10;
    if (veryDarkRatio > 0.3) wetScore += 15;
    else if (veryDarkRatio > 0.15) wetScore += 8;
    if (veryLightRatio > 0.3) wetScore -= 25;
    else if (lightRatio > 0.4) wetScore -= 15;
    else if (lightRatio > 0.25) wetScore -= 8;
    if (sandyRatio > 0.25) wetScore -= 25;
    else if (sandyRatio > 0.15) wetScore -= 15;
    else if (sandyRatio > 0.08) wetScore -= 8;
    if (brownRatio > 0.35) wetScore -= 20;
    else if (brownRatio > 0.2) wetScore -= 10;
    if (wetBrownRatio > 0.4) wetScore += 18;
    else if (wetBrownRatio > 0.25) wetScore += 10;
    else if (wetBrownRatio > 0.15) wetScore += 5;
    if (blueRatio > 0.2) wetScore += 12;
    else if (blueRatio > 0.1) wetScore += 6;
    if (avgSaturation > 0.25) wetScore += 5;
    else if (avgSaturation < 0.1) wetScore -= 5;
    if (greenRatio > 0.4) wetScore -= 15;

    const isWet = wetScore >= 30;
    let confidence = isWet
      ? Math.min(95, 55 + Math.floor(wetScore * 0.8))
      : Math.min(95, 55 + Math.floor(Math.abs(wetScore) * 0.8));
    confidence = Math.max(50, confidence);
    const status = isWet ? 'wet' : 'dry';
    const reason = isWet
      ? `Zameen bheegi hai (darkness: ${(darkRatio * 100).toFixed(0)}%, brightness: ${avgBrightness.toFixed(0)})`
      : `Zameen sukhi hai (brightness: ${avgBrightness.toFixed(0)}, sandy: ${(sandyRatio * 100).toFixed(0)}%, light pixels: ${(lightRatio * 100).toFixed(0)}%)`;

    console.log(`📸 PIXEL Analysis: WetScore=${wetScore}, Result=${status}, Confidence=${confidence}%`);
    return { status, confidence, reason, wetScore };
  } catch (err) {
    console.error('❌ Soil analysis error:', err);
    return { status: 'dry', confidence: 50, reason: 'Image analysis mein error aayi', wetScore: 0 };
  }
}

function analyzeSoilMoistureBasic(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const fileBytes = new Uint8Array(imageBuffer);
    const totalBytes = fileBytes.length;
    const sampleSize = Math.min(totalBytes, 100000);
    const step = Math.max(1, Math.floor(totalBytes / sampleSize));
    let darkCount = 0, lightCount = 0, totalSampled = 0, sumValues = 0;
    let warmCount = 0, coolCount = 0;
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
      if (v1 > v3 * 1.2 && v2 > v3) warmCount++;
      if (v3 > v1 * 0.9 && v3 > v2 * 0.9) coolCount++;
    }
    if (totalSampled === 0) return { status: 'dry', confidence: 50, reason: 'Image analyze nahi ho payi', wetScore: 0 };
    const avgBrightness = sumValues / totalSampled;
    const darkRatio = darkCount / totalSampled;
    const lightRatio = lightCount / totalSampled;
    const warmRatio = warmCount / totalSampled;
    const coolRatio = coolCount / totalSampled;
    let wetScore = 0;
    if (avgBrightness < 90) wetScore += 25;
    else if (avgBrightness < 110) wetScore += 15;
    else if (avgBrightness < 130) wetScore += 5;
    else if (avgBrightness < 150) wetScore -= 5;
    else wetScore -= 15;
    if (darkRatio > 0.35) wetScore += 20;
    else if (darkRatio > 0.2) wetScore += 10;
    else wetScore -= 5;
    if (lightRatio > 0.4) wetScore -= 20;
    else if (lightRatio > 0.25) wetScore -= 10;
    if (warmRatio > 0.3) wetScore -= 10;
    if (coolRatio > 0.15) wetScore += 10;
    const isWet = wetScore >= 35;
    let confidence = isWet ? Math.min(85, 50 + wetScore) : Math.min(85, 50 + Math.abs(wetScore));
    confidence = Math.max(50, confidence);
    const status = isWet ? 'wet' : 'dry';
    const reason = isWet
      ? `Zameen bheegi lag rahi hai (darkness: ${(darkRatio * 100).toFixed(0)}%, brightness: ${avgBrightness.toFixed(0)})`
      : `Zameen sukhi lag rahi hai (brightness: ${avgBrightness.toFixed(0)}, light: ${(lightRatio * 100).toFixed(0)}%)`;
    return { status, confidence, reason, wetScore };
  } catch (err) {
    return { status: 'dry', confidence: 50, reason: 'Analysis error', wetScore: 0 };
  }
}

// ============================================================
// API ROUTES - MongoDB version with JSON fallback
// ============================================================

// List all trees
app.get('/api/trees', async (req, res) => {
  try {
    if (mongoConnected) {
      const trees = await Tree.find({}).lean();
      // Format to match old API shape
      return res.json(trees.map(t => ({
        id: t.id,
        species: t.species,
        latitude: t.latitude,
        longitude: t.longitude,
        created_at: t.created_at
      })));
    }
    const db = readDB();
    res.json(db.trees || []);
  } catch (err) {
    console.error('GET /api/trees error:', err);
    res.status(500).json({ error: 'Failed to load trees' });
  }
});

// Register tree
app.post('/api/trees', async (req, res) => {
  try {
    console.log('📥 Register tree request body:', JSON.stringify(req.body));
    const { species, latitude, longitude } = req.body;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Latitude aur Longitude sahi se daalo' });
    }
    if (lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'Latitude -90 se 90 ke beech hona chahiye' });
    }
    if (lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Longitude -180 se 180 ke beech hona chahiye' });
    }
    const id = uuidv4();

    if (mongoConnected) {
      const newTree = new Tree({
        id,
        species: species || 'Unknown',
        latitude: lat,
        longitude: lng,
        created_at: new Date()
      });
      await newTree.save();
      console.log(`✅ Tree registered in MongoDB: ${id}`);
      return res.json({ treeId: id });
    }

    // JSON fallback
    const newTree = { id, species: species || 'Unknown', latitude: lat, longitude: lng, created_at: new Date().toISOString() };
    const db = readDB();
    db.trees.push(newTree);
    writeDB(db);
    console.log(`✅ Tree registered in JSON: ${id}`);
    res.json({ treeId: id });
  } catch (err) {
    console.error('POST /api/trees error:', err);
    res.status(500).json({ error: 'Tree register nahi ho paya: ' + err.message });
  }
});

// Get tree details
app.get('/api/trees/:id', async (req, res) => {
  try {
    if (mongoConnected) {
      const tree = await Tree.findOne({ id: req.params.id }).lean();
      if (!tree) return res.status(404).json({ error: 'Tree not found' });
      return res.json(tree);
    }
    const db = readDB();
    const tree = db.trees.find(t => t.id === req.params.id);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    res.json(tree);
  } catch (err) {
    console.error('GET /api/trees/:id error:', err);
    res.status(500).json({ error: 'Failed to get tree details' });
  }
});

// Upload soil image
app.post('/api/trees/:id/soil', upload.single('soilImage'), async (req, res) => {
  try {
    const treeId = req.params.id;
    let tree;

    if (mongoConnected) {
      tree = await Tree.findOne({ id: treeId }).lean();
    } else {
      const db = readDB();
      tree = db.trees.find(t => t.id === treeId);
    }

    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    if (!req.file) return res.status(400).json({ error: 'Image required' });

    console.log(`📷 Analyzing soil image for tree: ${treeId}`);
    const imagePath = path.join(uploadDir, req.file.filename);
    const analysis = await analyzeSoilMoisture(imagePath);
    const eventId = uuidv4();

    if (mongoConnected) {
      const newEvent = new WateringEvent({
        id: eventId,
        tree_id: treeId,
        timestamp: new Date(),
        status: analysis.status,
        confidence: analysis.confidence,
        image_path: req.file.filename,
        reason: analysis.reason,
        wet_score: analysis.wetScore
      });
      await newEvent.save();
    } else {
      const db = readDB();
      db.watering_events.push({
        id: eventId,
        tree_id: treeId,
        timestamp: new Date().toISOString(),
        status: analysis.status,
        confidence: analysis.confidence,
        image_path: req.file.filename,
        reason: analysis.reason,
        wet_score: analysis.wetScore
      });
      writeDB(db);
    }

    console.log(`📸 Result: ${analysis.status} (score: ${analysis.wetScore})`);
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
app.get('/api/trees/:id/history', async (req, res) => {
  try {
    if (mongoConnected) {
      const history = await WateringEvent.find({ tree_id: req.params.id })
        .sort({ timestamp: -1 })
        .lean();
      return res.json(history);
    }
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

// Get latest watering event
app.get('/api/trees/:id/latest', async (req, res) => {
  try {
    if (mongoConnected) {
      const event = await WateringEvent.findOne({ tree_id: req.params.id })
        .sort({ timestamp: -1 })
        .lean();
      return res.json(event || null);
    }
    const db = readDB();
    const events = (db.watering_events || [])
      .filter(e => e.tree_id === req.params.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(events[0] || null);
  } catch (err) {
    console.error('GET /api/trees/:id/latest error:', err);
    res.status(500).json({ error: 'Failed to load latest event' });
  }
});

// Mark water given
app.post('/api/trees/:id/watered', async (req, res) => {
  try {
    const treeId = req.params.id;
    let tree;

    if (mongoConnected) {
      tree = await Tree.findOne({ id: treeId }).lean();
    } else {
      const db = readDB();
      tree = db.trees.find(t => t.id === treeId);
    }

    if (!tree) return res.status(404).json({ error: 'Tree not found' });

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    let hasRecentProof = false;

    if (mongoConnected) {
      const recentWet = await WateringEvent.findOne({
        tree_id: treeId,
        status: 'wet',
        timestamp: { $gte: tenMinutesAgo }
      }).lean();
      hasRecentProof = !!recentWet;
    } else {
      const db = readDB();
      const recentEvents = (db.watering_events || [])
        .filter(e => e.tree_id === treeId && e.status === 'wet')
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      hasRecentProof = recentEvents.length > 0 && new Date(recentEvents[0].timestamp) > tenMinutesAgo;
    }

    if (!hasRecentProof) {
      return res.status(400).json({
        error: 'Pehle bheegi zameen ki photo upload karo! Bina proof ke pani record nahi hoga.',
        needsProof: true
      });
    }

    const eventId = uuidv4();

    if (mongoConnected) {
      const newEvent = new WateringEvent({
        id: eventId,
        tree_id: treeId,
        timestamp: new Date(),
        status: 'watered',
        confidence: 100,
        image_path: null
      });
      await newEvent.save();
    } else {
      const db = readDB();
      db.watering_events.push({
        id: eventId,
        tree_id: treeId,
        timestamp: new Date().toISOString(),
        status: 'watered',
        confidence: 100,
        image_path: null
      });
      writeDB(db);
    }

    console.log(`✅ Watering recorded for tree ${treeId}`);
    res.json({ success: true, eventId });
  } catch (err) {
    console.error('POST /api/trees/:id/watered error:', err);
    res.status(500).json({ error: 'Failed to record watering' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mongodb: mongoConnected,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Start server - connect to MongoDB first, then start
async function startServer() {
  await connectMongoDB();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🗄️  Storage: ${mongoConnected ? 'MongoDB Atlas (PERMANENT ✅)' : 'JSON file (⚠️ data lost on restart)'}`);
  });
}

startServer();
