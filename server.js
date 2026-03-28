const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ✅ FIXED LowDB imports
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${req.params.id}_${Date.now()}${ext}`;
    cb(null, filename);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'));
  },
});

// LowDB setup — absolute path for Render compatibility
const dbPath = path.join(__dirname, 'db.json');
const adapter = new JSONFileSync(dbPath);
const db = new LowSync(adapter, { trees: [], watering_events: [] });

db.read();
if (!db.data) {
  db.data = { trees: [], watering_events: [] };
  db.write();
}

// Generate event ID
function generateEventId() {
  return uuidv4();
}

// List all trees
app.get('/api/trees', (req, res) => {
  try {
    db.read();
    res.json(db.data.trees || []);
  } catch (err) {
    console.error('GET /api/trees error:', err);
    res.status(500).json({ error: 'Failed to load trees' });
  }
});

// Register tree
app.post('/api/trees', (req, res) => {
  try {
    const { species, latitude, longitude } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'Latitude and longitude required' });
    }

    const id = uuidv4();

    const newTree = {
      id,
      species: species || null,
      latitude,
      longitude,
      created_at: new Date().toISOString()
    };

    db.read();
    db.data.trees.push(newTree);
    db.write();

    res.json({ treeId: id });
  } catch (err) {
    console.error('POST /api/trees error:', err);
    res.status(500).json({ error: 'Failed to register tree' });
  }
});

// Get tree details
app.get('/api/trees/:id', (req, res) => {
  try {
    db.read();
    const tree = db.data.trees.find(t => t.id === req.params.id);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    res.json(tree);
  } catch (err) {
    console.error('GET /api/trees/:id error:', err);
    res.status(500).json({ error: 'Failed to get tree details' });
  }
});

// Upload soil image
app.post('/api/trees/:id/soil', upload.single('soilImage'), (req, res) => {
  try {
    const treeId = req.params.id;
    db.read();

    const tree = db.data.trees.find(t => t.id === treeId);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });

    if (!req.file) {
      return res.status(400).json({ error: 'Image required' });
    }

    const isWet = Math.random() > 0.5;
    const status = isWet ? 'wet' : 'dry';
    const confidence = (Math.random() * 30 + 70).toFixed(2);

    const eventId = generateEventId();

    const newEvent = {
      id: eventId,
      tree_id: treeId,
      timestamp: new Date().toISOString(),
      status,
      confidence: Number(confidence),
      image_path: req.file.filename
    };

    db.data.watering_events.push(newEvent);
    db.write();

    res.json({ status, confidence, imageUrl: `/uploads/${req.file.filename}` });
  } catch (err) {
    console.error('POST /api/trees/:id/soil error:', err);
    res.status(500).json({ error: 'Failed to analyze soil' });
  }
});

// Get watering history
app.get('/api/trees/:id/history', (req, res) => {
  try {
    db.read();
    const history = (db.data.watering_events || [])
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
    db.read();
    const events = (db.data.watering_events || [])
      .filter(e => e.tree_id === req.params.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (events.length === 0) return res.json(null);
    res.json(events[0]);
  } catch (err) {
    console.error('GET /api/trees/:id/latest error:', err);
    res.status(500).json({ error: 'Failed to load latest event' });
  }
});

// Mark water given (optional confirmation)
app.post('/api/trees/:id/watered', (req, res) => {
  try {
    db.read();
    const treeId = req.params.id;
    const tree = db.data.trees.find(t => t.id === treeId);
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    const eventId = generateEventId();
    const newEvent = {
      id: eventId,
      tree_id: treeId,
      timestamp: new Date().toISOString(),
      status: 'watered',
      confidence: 100,
      image_path: null
    };
    db.data.watering_events.push(newEvent);
    db.write();
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