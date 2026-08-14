const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Configuration
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'nexai_secret_token_key';

// Connexion MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connecté à MongoDB Atlas pour NexAI'))
  .catch((err) => console.error('❌ Erreur de connexion MongoDB :', err));

// ==========================================
// MODÈLES DE DONNÉES
// ==========================================

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  subscriptionActive: { type: Boolean, default: true },
  subscriptionExpiresAt: { type: Date, default: () => new Date(Date.now() + 7*24*60*60*1000) },
  deploymentsFreeCount: { type: Number, default: 3 },
  deploymentsPaidCredits: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const siteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  siteName: String,
  description: String,
  status: { type: String, default: 'En attente' }
});
const Site = mongoose.model('Site', siteSchema);

const resourceSchema = new mongoose.Schema({
  categoryId: Number, // 1 à 17
  categoryName: String,
  title: String,
  type: { type: String, enum: ['pdf', 'video'] },
  fileUrl: String
});
const Resource = mongoose.model('Resource', resourceSchema);

// ==========================================
// MIDDLEWARE DE SÉCURITÉ
// ==========================================
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ error: 'Accès refusé.' });
  
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token invalide.' });
    req.user = decoded;
    next();
  });
}

// ==========================================
// ROUTES
// ==========================================

// Authentification
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = new User({ email, password: hashedPassword });
  await newUser.save();
  res.status(201).json({ message: 'Inscription réussie.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password))) 
    return res.status(401).json({ error: 'Identifiants invalides.' });

  const isSubActive = user.subscriptionActive && new Date() < new Date(user.subscriptionExpiresAt);
  const token = jwt.sign({ userId: user._id, active: isSubActive }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, subscriptionActive: isSubActive });
});

// Catalogue & Sécurité Média (17 Niches)
app.get('/api/catalog', verifyToken, async (req, res) => {
  const resources = await Resource.find();
  const catalog = resources.map(item => ({
    id: item._id,
    categoryName: item.categoryName,
    title: item.title,
    type: item.type,
    url: req.user.active ? item.fileUrl : null,
    locked: !req.user.active
  }));
  res.json(catalog);
});

app.get('/api/secure-stream/:id', verifyToken, async (req, res) => {
  if (!req.user.active) return res.status(403).json({ error: 'Abonnement requis (5 000 FCFA).' });
  const resource = await Resource.findById(req.params.id);
  res.json({ secureUrl: resource.fileUrl, watermark: 'NexAI - Usage protégé' });
});

// Gestion des sites (Déploiements)
app.post('/api/sites/deploy', verifyToken, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user.subscriptionActive) return res.status(403).json({ error: 'Abonnement inactif.' });

  if (user.deploymentsFreeCount > 0) user.deploymentsFreeCount--;
  else if (user.deploymentsPaidCredits > 0) user.deploymentsPaidCredits--;
  else return res.status(400).json({ error: 'Quota épuisé. Rechargez 1 000 FCFA via Chariow.' });

  await user.save();
  const newSite = new Site({ userId: user._id, ...req.body });
  await newSite.save();
  res.json({ message: 'Site en cours de déploiement.', site: newSite });
});

// Webhook Paiement Chariow
app.post('/api/payments/webhook', async (req, res) => {
  const { email, type, amount } = req.body;
  const user = await User.findOne({ email });
  if (type === 'subscription' && amount === 5000) {
    user.subscriptionActive = true;
    user.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else if (type === 'deployment_pack' && amount === 1000) {
    user.deploymentsPaidCredits += 3;
  }
  await user.save();
  res.json({ message: 'Paiement traité.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur NexAI opérationnel sur le port ${PORT}`));