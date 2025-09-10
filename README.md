# Vox App Backend

Backend server for Vox App application providing speech-to-text functionality and emotion analysis.

## Features

- **Real-time Speech-to-Text**: Using AssemblyAI for live transcription
- **Emotion Analysis**: Analyzes audio features (volume, pitch, speech rate) to detect emotions
- **WebSocket Communication**: Real-time bidirectional communication with frontend
- **Audio Processing**: Pitch detection and volume analysis
- **CORS Support**: Configured for frontend development

## Prerequisites

- Node.js 18.0.0 or higher
- AssemblyAI API key

## Installation

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp env.example .env
   ```

4. Edit `.env` file with your configuration:
   ```
   ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
   PORT=3001
   CORS_ORIGINS=http://localhost:3000,http://localhost:5173
   ```

## Running the Server

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on port 3001 by default (configurable via PORT environment variable).

## API Endpoints

### Health Check
- **GET** `/api/health` - Returns server status and active sessions

### Stream Information
- **GET** `/api/stream-info` - Returns stream URL information

## WebSocket Events

### Client to Server
- `start-transcription` - Start a new transcription session
- `audio-data` - Send audio data for processing
- `stop-transcription` - Stop the current transcription session

### Server to Client
- `transcription-ready` - Confirmation that transcription is ready
- `transcription-result` - Partial or final transcript results
- `audio-volume` - Real-time audio volume and emotion data
- `audio-tone` - Emotion analysis results tied to specific transcripts
- `transcription-error` - Error notifications
- `transcription-stopped` - Confirmation that transcription has stopped

## Audio Analysis

The backend performs real-time analysis of audio features:

- **Volume**: RMS volume calculation from audio buffer
- **Pitch**: YIN algorithm for fundamental frequency detection
- **Speech Rate**: Words per minute calculation from transcript timing
- **Emotion Classification**: Heuristic-based emotion detection using audio features

## Emotion Detection

The system classifies emotions based on:
- Volume levels (converted to dB scale)
- Pitch frequency
- Speech rate (words per minute)

Supported emotions:
- Excited (high volume, high pitch, fast speech)
- Sad (low volume, low pitch, slow speech)
- Angry (high volume, slow speech)
- Happy (high pitch, fast speech)
- Calm (low pitch, slow speech)
- Neutral (default)

## Development

The backend serves the built frontend from the parent directory's `dist` folder. Make sure to build the frontend before running the backend in production mode.

## Dependencies

- **express**: Web server framework
- **socket.io**: WebSocket communication
- **assemblyai**: Speech-to-text API
- **pitchfinder**: Audio pitch detection
- **cors**: Cross-origin resource sharing

## License

ISC
