import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { AssemblyAI } from 'assemblyai';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { YIN } from 'pitchfinder';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin:  ["http://localhost:3000", "http://localhost:5173"], // allow both
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('../dist')); // Serve built frontend from parent directory

// AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY || "ae9025de09ce45cbb323225c6c96a9b5"
});

// Store active transcription sessions
const activeSessions = new Map();

// Store audio features for emotion analysis
const audioFeatures = new Map();

// Store audio features with timestamps for precise speech analysis
const audioFeatureHistory = new Map();

// Initialize pitch detector
const detectPitch = YIN({ sampleRate: 16000 });


// Function to calculate RMS volume from audio buffer
function calculateRMSVolume(audioBuffer) {
  let sum = 0;
  const samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
  
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  
  const rms = Math.sqrt(sum / samples.length);
  // Normalize to 0-100 scale
  return Math.min(100, Math.max(0, (rms / 32768) * 100));
}

// Function to detect pitch from audio buffer
function getPitch(audioBuffer) {
  try {
    // Convert Int16Array to Float32Array for pitch detection
    const int16Samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
    const float32Samples = new Float32Array(int16Samples.length);
    
    // Convert from Int16 (-32768 to 32767) to Float32 (-1 to 1)
    for (let i = 0; i < int16Samples.length; i++) {
      float32Samples[i] = int16Samples[i] / 32768.0;
    }
    
    return detectPitch(float32Samples); // Returns pitch in Hz
  } catch (error) {
    console.error('Pitch detection error:', error);
    return null;
  }
}

// Function to calculate speech rate (words per minute)
function calculateSpeechRate(turn) {
  if (!turn.words || turn.words.length < 2) return 0;
  
  const words = turn.words;
  const duration = (words[words.length - 1]?.end - words[0]?.start) / 1000; // seconds
  if (duration <= 0) return 0;
  
  const wpm = (words.length / duration) * 60;
  return wpm;
}

// Heuristic emotion classifier
function classifyEmotion({ volume, pitch, wpm }) {
  // Convert volume from 0-100 scale to dB-like scale for easier thresholding
  const volumeDb = volume > 0 ? 20 * Math.log10(volume / 100) : -60;
  
  if (volumeDb > -15 && pitch > 200 && wpm > 160) {
    return { emotion: "excited", confidence: 0.8, visualStyle: "neon, comic, fast brush" };
  }
  if (volumeDb < -25 && pitch < 150 && wpm < 100) {
    return { emotion: "sad", confidence: 0.7, visualStyle: "grayscale, watercolor, rainy" };
  }
  if (volumeDb > -10 && wpm < 120) {
    return { emotion: "angry", confidence: 0.6, visualStyle: "red/orange, jagged strokes" };
  }
  if (pitch > 180 && wpm > 140) {
    return { emotion: "happy", confidence: 0.7, visualStyle: "bright colors, smooth curves" };
  }
  if (pitch < 120 && wpm < 80) {
    return { emotion: "calm", confidence: 0.6, visualStyle: "soft pastels, gentle lines" };
  }
  
  return { emotion: "neutral", confidence: 0.5, visualStyle: "pastel, clean line art" };
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Speech-to-text server is running',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size
  });
});

// Add endpoint to get stream URL info
app.get('/api/stream-info', (req, res) => {
  res.json({
    message: 'Stream URL information',
    note: 'Use the lvpr.tv URL displayed in the Studio interface',
    format: 'https://lvpr.tv/?v={playback_id}&lowLatency=force&autoplay=true',
    timeout: '15 seconds',
    fallback: 'Open URL in new tab if iframe times out'
  });
});




// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('start-transcription', async (data) => {
    try {
      const sessionId = socket.id;
      
      // Create streaming transcriber using v3 API
      const transcriber = client.streaming.transcriber({
        sampleRate: 16000,
        formatTurns: true,
        sentiment_analysis: true
      });

      transcriber.on("open", ({ id }) => {
        console.log(`Session opened with ID: ${id}`);
        socket.emit('transcription-ready', { message: 'Ready to receive audio', sessionId: id });
      });

      transcriber.on("error", (error) => {
        console.error("Transcription error:", error);
        socket.emit('transcription-error', { error: error.message || error.toString() });
      });

      transcriber.on("close", (code, reason) => {
        console.log("Session closed:", code, reason);
        socket.emit('transcription-stopped', { message: 'Transcription session closed', code, reason });
        activeSessions.delete(sessionId);
        audioFeatures.delete(sessionId); // Clean up audio features
        audioFeatureHistory.delete(sessionId); // Clean up audio feature history
      });

      // Handle partial transcripts (live in-progress text)
      transcriber.on("partial_transcript", (partial) => {
        if (partial.text) {
          console.log('📝 Partial Text:', partial.text);
          
          // Emit partial transcript for live display
          socket.emit('transcription-result', {
            message_type: 'partial_transcript',
            text: partial.text,
            timestamp: new Date().toISOString()
          });
        }
      });

      // Handle final transcripts (stable text after pause)
      transcriber.on("turn", (turn) => {
        if (turn.transcript) {
          console.log('📝 Final Text:', turn.transcript);
          
          // Calculate speech rate
          const wpm = calculateSpeechRate(turn);
          console.log('🗣️ Speech Rate:', wpm.toFixed(1), 'WPM');
          
          // Get audio features that correspond to this specific speech turn
          const history = audioFeatureHistory.get(sessionId);
          if (history && history.length > 0) {
            // Calculate the time window for this speech turn
            const turnStartTime = turn.words && turn.words.length > 0 ? turn.words[0].start : Date.now() - 3000;
            const turnEndTime = turn.words && turn.words.length > 0 ? turn.words[turn.words.length - 1].end : Date.now();
            
            // Filter audio features to only include those during the actual speech
            const speechAudioFeatures = history.filter(feature => 
              feature.timestamp >= turnStartTime && feature.timestamp <= turnEndTime
            );
            
            if (speechAudioFeatures.length > 0) {
              // Calculate average volume and pitch from speech-specific samples
              const avgVolume = speechAudioFeatures.reduce((sum, f) => sum + f.volume, 0) / speechAudioFeatures.length;
              const validPitches = speechAudioFeatures.filter(f => f.pitch > 0);
              const avgPitch = validPitches.length > 0 ? 
                validPitches.reduce((sum, f) => sum + f.pitch, 0) / validPitches.length : 0;
              
              console.log(`🎯 Speech-specific analysis: ${speechAudioFeatures.length} audio samples during "${turn.transcript}"`);
              
              // Classify emotion based on speech-specific features
              const emotionData = classifyEmotion({ 
                volume: avgVolume, 
                pitch: avgPitch, 
                wpm: wpm 
              });
              
              console.log('😊 Emotion:', emotionData.emotion, `(${emotionData.confidence.toFixed(2)})`);
              console.log('🎨 Visual Style:', emotionData.visualStyle);
              
              // Emit emotion data tied to this specific transcript
              socket.emit('audio-tone', {
                emotion: emotionData.emotion,
                confidence: emotionData.confidence,
                visualStyle: emotionData.visualStyle,
                features: {
                  volume: avgVolume,
                  pitch: avgPitch,
                  wpm: wpm
                },
                transcript: turn.transcript,
                timestamp: new Date().toISOString()
              });
            } else {
              console.log('⚠️ No audio features found for this speech turn');
            }
          }
          
          // Emit final transcript (pause detected)
          socket.emit('transcription-result', {
            message_type: 'final_transcript',
            text: turn.transcript,
            confidence: turn.confidence,
            wpm: wpm,
            timestamp: new Date().toISOString()
          });
          
          // Emit sentiment analysis if available (fallback)
          if (turn.sentiment_analysis_results) {
            console.log('😊 Sentiment (API):', turn.sentiment_analysis_results);
            socket.emit('audio-sentiment-api', {
              sentiment: turn.sentiment_analysis_results,
              timestamp: new Date().toISOString()
            });
          }
        }
      });

      // Listen for audio stats if available
      transcriber.on("audio_stats", (stats) => {
        console.log('📊 Audio Stats Volume:', stats.volume);
        socket.emit('audio-stats', {
          volume: stats.volume,
          timestamp: new Date().toISOString()
        });
      });

      await transcriber.connect();
      activeSessions.set(sessionId, transcriber);

    } catch (error) {
      console.error('Error starting transcription:', error);
      socket.emit('transcription-error', { error: error.message });
    }
  });

  socket.on('audio-data', async (audioData) => {
    const sessionId = socket.id;
    const transcriber = activeSessions.get(sessionId);
    
    if (transcriber) {
      try {
        // Convert base64 audio data to buffer and send to transcriber
        const audioBuffer = Buffer.from(audioData, "base64");
        
        // Calculate RMS volume for DIY volume detection
        const volume = calculateRMSVolume(audioBuffer);
        
        // Detect pitch
        const pitch = getPitch(audioBuffer);
        
        
        // Store audio features with timestamp for precise speech analysis
        const timestamp = Date.now();
        if (!audioFeatureHistory.has(sessionId)) {
          audioFeatureHistory.set(sessionId, []);
        }
        
        const history = audioFeatureHistory.get(sessionId);
        history.push({
          volume: volume,
          pitch: pitch || 0,
          timestamp: timestamp
        });
        
        // Keep only last 5 seconds of audio features
        const fiveSecondsAgo = timestamp - 5000;
        const filteredHistory = history.filter(feature => feature.timestamp > fiveSecondsAgo);
        audioFeatureHistory.set(sessionId, filteredHistory);
        
        // Also maintain rolling average for real-time display
        if (!audioFeatures.has(sessionId)) {
          audioFeatures.set(sessionId, {
            volumes: [],
            pitches: [],
            lastUpdate: timestamp
          });
        }
        
        const features = audioFeatures.get(sessionId);
        features.volumes.push(volume);
        features.pitches.push(pitch || 0);
        features.lastUpdate = timestamp;
        
        // Keep only last 10 samples for rolling average
        if (features.volumes.length > 10) {
          features.volumes.shift();
          features.pitches.shift();
        }
        
        // Calculate rolling averages for real-time emotion detection
        const avgVolume = features.volumes.reduce((sum, v) => sum + v, 0) / features.volumes.length;
        const validPitches = features.pitches.filter(p => p > 0);
        const avgPitch = validPitches.length > 0 ? 
          validPitches.reduce((sum, p) => sum + p, 0) / validPitches.length : 0;
        
        // Simple real-time emotion detection based on current audio features
        let realtimeEmotion = { emotion: "neutral", confidence: 0.5, visualStyle: "pastel, clean line art" };
        if (features.volumes.length >= 3) { // Only after we have some data
          realtimeEmotion = classifyEmotion({ 
            volume: avgVolume, 
            pitch: avgPitch, 
            wpm: 0 // No WPM for real-time detection
          });
        }
        
        // Emit volume data with real-time emotion
        socket.emit('audio-volume', {
          volume: volume,
          pitch: pitch,
          emotion: realtimeEmotion.emotion,
          confidence: realtimeEmotion.confidence,
          visualStyle: realtimeEmotion.visualStyle,
          timestamp: new Date().toISOString()
        });
        
        await transcriber.sendAudio(audioBuffer);
      } catch (error) {
        console.error('Error processing audio data:', error);
        socket.emit('transcription-error', { error: 'Failed to process audio data' });
      }
    } else {
      console.warn('No active transcriber found for session:', sessionId);
    }
  });

  socket.on('stop-transcription', async () => {
    const sessionId = socket.id;
    const transcriber = activeSessions.get(sessionId);
    
    if (transcriber) {
      try {
        await transcriber.close();
        activeSessions.delete(sessionId);
        audioFeatures.delete(sessionId); // Clean up audio features
        audioFeatureHistory.delete(sessionId); // Clean up audio feature history
        socket.emit('transcription-stopped', { message: 'Transcription stopped' });
      } catch (error) {
        console.error('Error stopping transcription:', error);
        socket.emit('transcription-error', { error: error.message });
      }
    }
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    const sessionId = socket.id;
    const transcriber = activeSessions.get(sessionId);
    
    if (transcriber) {
      try {
        await transcriber.close();
        activeSessions.delete(sessionId);
        audioFeatures.delete(sessionId); // Clean up audio features
        audioFeatureHistory.delete(sessionId); // Clean up audio feature history
      } catch (error) {
        console.error('Error closing transcription on disconnect:', error);
      }
    }
  });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist', 'index.html'));
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`🚀 Speech-to-text server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for real-time transcription`);
  console.log(`🌐 Frontend will be served from http://localhost:${PORT}`);
});
