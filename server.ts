import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { db } from './src/server/db';
import { hashPassword, generateToken, verifyToken, generateVerificationCode } from './src/server/auth';
import { Track, Playlist, User } from './src/types';

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors());

// Custom simple logger/session parser middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.split(' ')[1];
  const verified = verifyToken(token);
  if (verified) {
    req.userId = verified.userId;
    req.userEmail = verified.email;
  }
  next();
};

app.use(authenticate);

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

// ----------------------------------------------------
// MODULE 1: USER MANAGEMENT & AUTHENTICATION ENDPOINTS
// ----------------------------------------------------

// Register
app.post('/api/auth/register', (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  const existing = db.getUserByEmail(email);
  if (existing) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const passwordHash = hashPassword(password);
  const newUser: User = {
    id: 'user-' + Math.random().toString(36).substr(2, 9),
    username,
    email,
    favorite_genres: [],
    favorite_artists: [],
    subscription_type: 'FREE',
    created_at: new Date().toISOString()
  };

  db.createUser(newUser, passwordHash);
  const token = generateToken({ userId: newUser.id, email: newUser.email });
  res.status(201).json({ user: newUser, token });
});

// Login
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const userRecord = db.getUserByEmail(email);
  if (!userRecord || userRecord.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { passwordHash, ...user } = userRecord;
  const token = generateToken({ userId: user.id, email: user.email });
  res.json({ user, token });
});

// Get Current User
app.get('/api/auth/me', (req: Request, res: Response) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = db.getUser(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user });
});

// Mock Google & Facebook login for high fidelity OAuth simulation
app.post('/api/auth/oauth', (req: Request, res: Response) => {
  const { provider, email, name, avatar } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'OAuth email and name are required' });
  }

  let userRecord = db.getUserByEmail(email);
  let user: User;

  if (!userRecord) {
    // Auto-create OAuth user
    user = {
      id: `oauth-${provider}-${Math.random().toString(36).substr(2, 9)}`,
      username: name.replace(/\s+/g, '_').toLowerCase(),
      email,
      profile_picture: avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${name}`,
      favorite_genres: ['Synthwave', 'Ambient'],
      favorite_artists: [],
      subscription_type: 'FREE',
      created_at: new Date().toISOString()
    };
    db.createUser(user, hashPassword(Math.random().toString(36)));
    db.addNotification(user.id, `Welcome to Online Music Gallery! You successfully connected with ${provider}.`, 'social');
  } else {
    const { passwordHash, ...rest } = userRecord;
    user = rest as User;
  }

  const token = generateToken({ userId: user.id, email: user.email });
  res.json({ user, token });
});

// Forgot / Reset Password Simulator
app.post('/api/auth/forgot-password', (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  const code = generateVerificationCode();
  // In a real production app we send an email. For high-fidelity mockup we print to server logs and return success.
  console.log(`[EMAIL SEND] Reset link code ${code} sent to ${email}`);
  res.json({ success: true, message: `Verification code successfully sent to ${email}.`, code });
});

app.post('/api/auth/reset-password', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const userRecord = db.getUserByEmail(email);
  if (!userRecord) {
    return res.status(404).json({ error: 'User not found' });
  }

  const hashed = hashPassword(password);
  db.updateUser(userRecord.id, {}); // Touch DB to ensure update or write custom updating hash helper
  // For simplicity, re-register user under the same ID or rewrite the user password inside DB
  const { passwordHash, ...user } = userRecord;
  db.createUser(user, hashed); // Overwrites password
  res.json({ success: true, message: 'Password reset successful!' });
});

// Update Profile
app.put('/api/users/profile', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { username, bio, favorite_genres, favorite_artists, profile_picture } = req.body;

  const updated = db.updateUser(req.userId, {
    username,
    bio,
    favorite_genres: Array.isArray(favorite_genres) ? favorite_genres : [],
    favorite_artists: Array.isArray(favorite_artists) ? favorite_artists : [],
    profile_picture
  });

  if (!updated) return res.status(404).json({ error: 'User profile not found' });
  res.json({ user: updated });
});


// ----------------------------------------------------
// MODULE 2: MUSIC CATALOG & TRACK MANAGEMENT
// ----------------------------------------------------

// Read all tracks with sorting & filtering
app.get('/api/tracks', (req: Request, res: Response) => {
  let tracks = db.getTracks();
  const { search, genre, sort, artistId } = req.query;

  // Search filter
  if (search) {
    const s = (search as string).toLowerCase();
    tracks = tracks.filter(t =>
      t.title.toLowerCase().includes(s) ||
      t.artist.toLowerCase().includes(s) ||
      t.album.toLowerCase().includes(s) ||
      t.genre.toLowerCase().includes(s)
    );
  }

  // Genre filter
  if (genre) {
    tracks = tracks.filter(t => t.genre.toLowerCase() === (genre as string).toLowerCase());
  }

  // Artist filter
  if (artistId) {
    tracks = tracks.filter(t => t.artistId === artistId);
  }

  // Sort logic
  if (sort === 'plays') {
    tracks.sort((a, b) => b.plays - a.plays);
  } else if (sort === 'likes') {
    tracks.sort((a, b) => b.likes - a.likes);
  } else {
    // Default newest upload date
    tracks.sort((a, b) => b.upload_date.localeCompare(a.upload_date));
  }

  res.json(tracks);
});

// Specific Track
app.get('/api/tracks/:id', (req: Request, res: Response) => {
  const track = db.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json(track);
});

// Admin Create/Upload Track
app.post('/api/tracks', (req: Request, res: Response) => {
  // Simple check for simulation support
  const { title, artist, genre, audio_file, cover_image, duration } = req.body;
  if (!title || !artist || !audio_file) {
    return res.status(400).json({ error: 'Title, artist, and audio file URL are required' });
  }

  const newTrackId = 'track-' + Math.random().toString(36).substr(2, 9);
  const newTrack = db.updateTrack(newTrackId, {
    id: newTrackId,
    title,
    artist,
    album: req.body.album || 'Single',
    genre: genre || 'Electronic',
    audio_file,
    cover_image: cover_image || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&q=80&w=400',
    duration: duration ? parseInt(duration) : 240,
    plays: 0,
    likes: 0,
    upload_date: new Date().toISOString()
  });

  res.status(201).json(newTrack);
});

// Admin delete track
app.delete('/api/tracks/:id', (req: Request, res: Response) => {
  db.deleteTrack(req.params.id);
  res.json({ success: true });
});

// Artists List
app.get('/api/artists', (req: Request, res: Response) => {
  res.json(db.getArtists());
});

// Artist Detail
app.get('/api/artists/:id', (req: Request, res: Response) => {
  const artist = db.getArtist(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  res.json(artist);
});

// Albums List
app.get('/api/albums', (req: Request, res: Response) => {
  res.json(db.getAlbums());
});


// ----------------------------------------------------
// MODULE 3: PLAYLIST MANAGEMENT
// ----------------------------------------------------

app.get('/api/playlists', (req: Request, res: Response) => {
  res.json(db.getPlaylists());
});

app.post('/api/playlists', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { title, description, cover_image, isPublic } = req.body;

  const user = db.getUser(req.userId);
  const platId = 'plat-' + Math.random().toString(36).substr(2, 9);
  const newPlaylist = db.updatePlaylist(platId, {
    id: platId,
    title: title || 'My New Playlist',
    description: description || 'No description provided.',
    cover_image: cover_image || 'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?auto=format&fit=crop&q=80&w=300',
    ownerId: req.userId,
    ownerName: user ? user.username : 'User',
    tracks: [],
    collaborators: [],
    followers: 0,
    isPublic: isPublic !== false
  });

  res.status(201).json(newPlaylist);
});

// Edit Playlist attributes
app.put('/api/playlists/:id', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const playlist = db.getPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  // Security: Owners or collaborators only
  if (playlist.ownerId !== req.userId && !playlist.collaborators.includes(req.userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { title, description, cover_image, isPublic, tracks, collaborators } = req.body;
  const updated = db.updatePlaylist(req.params.id, {
    title,
    description,
    cover_image,
    isPublic,
    tracks,
    collaborators
  });

  res.json(updated);
});

// Delete Playlist
app.delete('/api/playlists/:id', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const playlist = db.getPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  if (playlist.ownerId !== req.userId) {
    return res.status(403).json({ error: 'Only owners can delete playlists' });
  }

  db.deletePlaylist(req.params.id);
  res.json({ success: true });
});

// Add Song to Playlist
app.post('/api/playlists/:id/add-track', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { trackId } = req.body;
  const playlist = db.getPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  if (playlist.ownerId !== req.userId && !playlist.collaborators.includes(req.userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (playlist.tracks.includes(trackId)) {
    return res.status(400).json({ error: 'Track already in playlist' });
  }

  playlist.tracks.push(trackId);
  const updated = db.updatePlaylist(req.params.id, { tracks: playlist.tracks });
  res.json(updated);
});

// Remove Song from Playlist
app.post('/api/playlists/:id/remove-track', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { trackId } = req.body;
  const playlist = db.getPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  if (playlist.ownerId !== req.userId && !playlist.collaborators.includes(req.userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  playlist.tracks = playlist.tracks.filter(tid => tid !== trackId);
  const updated = db.updatePlaylist(req.params.id, { tracks: playlist.tracks });
  res.json(updated);
});


// ----------------------------------------------------
// MODULE 4: STREAMING & TRACK ENGAGEMENT (Queue, History, Likes, Comments)
// ----------------------------------------------------

// Listen tracking and increment stats
app.post('/api/tracks/:id/listen', (req: Request, res: Response) => {
  const trackId = req.params.id;
  if (req.userId) {
    db.addToHistory(req.userId, trackId);
  } else {
    // Increment count for anonymous plays too
    const track = db.getTrack(trackId);
    if (track) {
      db.updateTrack(trackId, { plays: track.plays + 1 });
    }
  }
  res.json({ success: true });
});

// Track Likes Check / Toggle
app.get('/api/likes', (req: Request, res: Response) => {
  if (!req.userId) return res.json([]);
  res.json(db.getLikes(req.userId));
});

app.post('/api/likes/toggle', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { trackId } = req.body;
  const result = db.toggleLike(req.userId, trackId);
  res.json(result);
});

// Listen History API
app.get('/api/history', (req: Request, res: Response) => {
  if (!req.userId) return res.json([]);
  const history = db.getHistory(req.userId);
  res.json(history);
});

// Comments API
app.get('/api/comments', (req: Request, res: Response) => {
  const { trackId } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId query param is required' });
  res.json(db.getComments(trackId as string));
});

app.post('/api/comments', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { trackId, comment } = req.body;
  if (!trackId || !comment) {
    return res.status(400).json({ error: 'trackId and comment body required' });
  }

  const user = db.getUser(req.userId);
  const username = user ? user.username : 'User';

  const newComment = db.createComment({
    id: 'comm-' + Math.random().toString(36).substr(2, 9),
    userId: req.userId,
    username,
    userAvatar: user?.profile_picture,
    trackId,
    comment,
    created_at: new Date().toISOString()
  });

  res.status(201).json(newComment);
});


// ----------------------------------------------------
// MODULE 5: SOCIAL NOTIFICATIONS & FEED
// ----------------------------------------------------

app.get('/api/notifications', (req: Request, res: Response) => {
  if (!req.userId) return res.json([]);
  res.json(db.getNotifications(req.userId));
});

app.post('/api/notifications/clear', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  db.markNotificationsRead(req.userId);
  res.json({ success: true });
});


// ----------------------------------------------------
// MODULE 6: COMPREHENSIVE AI & LOCAL RECOMMENDATIONS ENGINE
// ----------------------------------------------------

app.get('/api/recommendations', async (req: Request, res: Response) => {
  let user: User | undefined;
  if (req.userId) {
    user = db.getUser(req.userId);
  }

  // Fallback / Content-Based recommendation filtering logic in pure JS
  const tracks = db.getTracks();
  const sortedByPopular = [...tracks].sort((a,b) => b.plays - a.plays);

  let favoriteGenres = user?.favorite_genres || [];
  let favoriteArtists = user?.favorite_artists || [];

  // Seed default targets if empty to build personalized array
  if (favoriteGenres.length === 0) {
    favoriteGenres = ['Synthwave', 'Ambient', 'Lofi Hip Hop'];
  }

  // Calculate generic content score representing our recommender algorithm
  const withScore = tracks.map(t => {
    let score = t.plays * 0.001; // popularity score baseline
    if (favoriteGenres.some(g => t.genre.toLowerCase() === g.toLowerCase())) {
         score += 50; // high weight for genre match
    }
    if (favoriteArtists.some(art => t.artist.toLowerCase() === art.toLowerCase())) {
         score += 100; // very high match for pre-saved artist
    }
    return { track: t, score };
  });

  withScore.sort((a,b) => b.score - a.score);
  const bestRecs = withScore.slice(0, 5).map(item => item.track);

  // Now, let's incorporate server side high quality AI text modeling via @google/genai SDK!
  // If GEMINI_API_KEY is configured in server env, compile smart text description using it.
  let aiCommentary = "Curated automatically from your profile vibe, genre selections, and trend vectors.";
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: `Recommend a customized playlist description or high-vibe advice to a music lover whose favorite genres are [${favoriteGenres.join(', ')}] and who enjoys listening on a sleek glow-lit visual synth player. Write a brief 2-sentence poetic soundscape description that matches their taste. Keep it short.`,
      });
      if (response && response.text) {
        aiCommentary = response.text.trim();
      }
    } catch (err) {
      console.warn('Google GenAI recommendation simulation warning:', err);
    }
  }

  res.json({
    recommendations: bestRecs,
    aiCommentary,
    favoriteGenresMatched: favoriteGenres
  });
});


// ----------------------------------------------------
// MODULE 7: PAYMENT, PREMIUM TRIAL & COUPONS
// ----------------------------------------------------

// Coupon application
app.post('/api/subscriptions/apply-coupon', (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Coupon code required' });

  const discount = db.validateCoupon(code);
  if (discount === 0) {
    return res.status(400).json({ error: 'Invalid or expired promotional coupon' });
  }

  res.json({ code: code.toUpperCase(), discount, success: true });
});

// Standard subscription purchase & trial activating endpoints
app.post('/api/subscriptions/purchase', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { planName, couponApplied, paymentGateway } = req.body;

  let finalPrice = 9.99;
  if (couponApplied) {
    const discount = db.validateCoupon(couponApplied);
    finalPrice = Math.max(0, finalPrice * (1 - discount / 100));
  }

  // Update user model to Premium
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 30); // 30 day license

  db.updateUser(req.userId, {
    subscription_type: 'PREMIUM',
    subscription_expiry: expiry.toISOString()
  });

  db.addNotification(
    req.userId,
    `Premium Activated via ${paymentGateway || 'Stripe'}! Total charged: $${finalPrice.toFixed(2)}. Enjoy offline downloading!`,
    'subscription'
  );

  res.json({
    success: true,
    message: 'Subscription fully processed and active on container node.',
    plan: planName,
    expiry: expiry.toISOString()
  });
});

app.post('/api/subscriptions/trial', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 7); // 7 day trial

  db.updateUser(req.userId, {
    subscription_type: 'PREMIUM',
    subscription_expiry: expiry.toISOString()
  });

  db.addNotification(
    req.userId,
    '7-Day Free Trial Activated successfully! You now have unrestricted access.',
    'subscription'
  );

  res.json({
    success: true,
    message: '7-day trial activated.',
    expiry: expiry.toISOString()
  });
});

app.post('/api/subscriptions/cancel', (req: Request, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  db.updateUser(req.userId, {
    subscription_type: 'FREE',
    subscription_expiry: undefined
  });

  db.addNotification(
    req.userId,
    'Your premium subscription was cancelled. You will continue to have free limited mode access.',
    'subscription'
  );

  res.json({
    success: true,
    message: 'Premium subscription successfully canceled.'
  });
});


// ----------------------------------------------------
// ADMIN DASHBOARD ANALYTICS ENDPOINT
// ----------------------------------------------------

app.get('/api/admin/analytics', (req: Request, res: Response) => {
  res.json(db.getAnalytics());
});


// Serve Static Assets out of the standard web frontend build directory
app.use(express.static(path.join(process.cwd(), 'dist')));

// SPA redirection routing to fall back to index.html
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
});

// Let the server boot up on the platform configured port (3000)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Music Gallery backend running securely on port ${PORT}`);
});
