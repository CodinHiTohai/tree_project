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

// LowDB setup
const adapter = new JSONFileSync('db.json');
const db = new LowSync(adapter);

db.read();
if (!db.data) {
  db.data = { trees: [], watering_events: [] };
}

// Generate event ID
function generateEventId() {
  return uuidv4();
}

// List all trees
app.get('/api/trees', (req, res) => {
  db.read();
  res.json(db.data.trees);
});

// Register tree
app.post('/api/trees', (req, res) => {
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

  db.data.trees.push(newTree);
  db.write();

  res.json({ treeId: id });
});

// Get tree details
app.get('/api/trees/:id', (req, res) => {
  const tree = db.data.trees.find(t => t.id === req.params.id);
  if (!tree) return res.status(404).json({ error: 'Tree not found' });

  res.json(tree);
});

// Upload soil image
app.post('/api/trees/:id/soil', upload.single('soilImage'), (req, res) => {
  const treeId = req.params.id;

  const tree = db.data.trees.find(t => t.id === treeId);
  if (!tree) return res.status(404).json({ error: 'Tree not found' });

  // ✅ Safety check
  if (!req.file) {
    return res.status(400).json({ error: 'Image required' });
  }

  // Mock AI detection
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

  res.json({
    status,
    confidence,
    imageUrl: `/uploads/${req.file.filename}`
  });
});

// Get watering history
app.get('/api/trees/:id/history', (req, res) => {
  const history = db.data.watering_events
    .filter(e => e.tree_id === req.params.id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  res.json(history);
});

// Get latest watering event for a tree
app.get('/api/trees/:id/latest', (req, res) => {
  const events = db.data.watering_events
    .filter(e => e.tree_id === req.params.id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (events.length === 0) return res.json(null);
  res.json(events[0]);
});

// Mark water given (optional confirmation)
app.post('/api/trees/:id/watered', (req, res) => {
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
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 Phone access: http://192.168.1.34:${PORT}`);
});