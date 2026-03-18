# Renuir — Build & Run Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| npm | 10+ | bundled with Node |
| Xcode | 15+ | Mac App Store |
| CocoaPods | 1.15+ | `sudo gem install cocoapods` |
| Expo CLI | latest | `npm install -g expo-cli` |
| EAS CLI | latest | `npm install -g eas-cli` |

---

## Environment Setup

### Frontend (Renuir-claude)

```bash
cd Renuir-claude

# 1. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your actual values (Firebase keys, backend URL, etc.)

# 2. Install dependencies
npm install

# 3. Install iOS pods (required before Xcode build)
npx expo prebuild --platform ios
cd ios && pod install && cd ..
```

### Backend (Renuir-backend)

```bash
cd Renuir-backend

# 1. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your DB credentials, JWT secret, SMTP config, etc.

# 2. Install dependencies
npm install

# 3. Start PostgreSQL (local)
# Option A: Docker
docker run -d --name renuir-db \
  -e POSTGRES_DB=renuir \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=your_password \
  -p 5432:5432 postgres:16

# Option B: Homebrew (Mac)
brew install postgresql@16 && brew services start postgresql@16

# 4. Run the server (migrations run automatically on startup)
npm run dev
# Backend will be available at http://localhost:8080
```

---

## Running on iOS Simulator (Xcode)

```bash
cd Renuir-claude

# Option 1: Expo Go (fastest, no native modules)
npx expo start
# Press 'i' for iOS simulator or scan QR with Expo Go app

# Option 2: Full native build (required for Maps, Camera, SecureStore, Stripe)
npx expo run:ios
# This compiles the full native iOS app and opens it in Simulator
```

**What you'll see in Xcode Simulator:**
- Maps will require a valid `GOOGLE_MAPS_API_KEY`
- Social login (Google/Apple) may not work fully in Simulator — use OTP login
- Push notifications don't work in Simulator — use a physical device for FCM testing

---

## Running on Physical iOS Device

### Option A: Expo Development Build (recommended for testing)

```bash
# Install EAS CLI
npm install -g eas-cli
eas login

# Build a development client (one-time, takes ~10-15 min)
eas build --platform ios --profile development

# Once built, install on device via QR code, then:
npx expo start --dev-client
```

### Option B: Direct Xcode install

```bash
npx expo prebuild --platform ios
```

Then open `ios/renuirapp.xcworkspace` in Xcode:
1. Select your device as the build target
2. Set your Apple Developer Team in **Signing & Capabilities**
3. Press **Run** (⌘R)

---

## TestFlight Distribution

```bash
# Build for TestFlight
eas build --platform ios --profile preview

# Submit to App Store Connect
eas submit --platform ios --latest
```

### EAS `eas.json` Build Profiles

```json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "ios": { "simulator": false }
    },
    "production": {
      "autoIncrement": true
    }
  }
}
```

---

## EAS Secrets (Replaces Committed Keys)

After rotating the exposed API keys, set them as EAS secrets:

```bash
# Google Maps key (SEC-06: was committed to app.json — must be rotated)
eas secret:create --scope project --name GOOGLE_MAPS_API_KEY --value "AIza..."
eas secret:create --scope project --name GOOGLE_IOS_URL_SCHEME --value "com.googleusercontent.apps...."

# Firebase keys (SEC-05: must be rotated after repo exposure)
eas secret:create --scope project --name EXPO_PUBLIC_FIREBASE_API_KEY --value "AIza..."
eas secret:create --scope project --name EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID --value "..."
eas secret:create --scope project --name EXPO_PUBLIC_FIREBASE_APP_ID --value "..."

# Google OAuth
eas secret:create --scope project --name EXPO_PUBLIC_GOOGLE_CLIENT_ID --value "...apps.googleusercontent.com"
eas secret:create --scope project --name EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID --value "...apps.googleusercontent.com"

# Backend URL
eas secret:create --scope project --name EXPO_PUBLIC_BACKEND_URL --value "https://api.renuir.com"
```

---

## Running Tests

### Backend

```bash
cd Renuir-backend
npm test                # run once
npm run test:watch      # watch mode during development
```

### Frontend (to be added in Sprint 6 — EP-5)

```bash
# Placeholder — Jest + React Native Testing Library setup coming in Sprint 6
cd Renuir-claude
npm test
```

---

## Common Issues

### "Google Maps API key not set"
Set `GOOGLE_MAPS_API_KEY` in `.env` (local) or EAS secrets (builds).
The key was rotated — get the new one from Google Cloud Console.

### "Firebase apiKey is required"
Set all `EXPO_PUBLIC_FIREBASE_*` values in `.env`. The hardcoded fallback was removed in Sprint 0 (security fix SEC-05).

### "Pods not installed"
```bash
cd Renuir-claude/ios && pod install
```

### "Module not found: expo-secure-store"
```bash
cd Renuir-claude && npx expo install expo-secure-store
```

### Backend: "Migration failed"
Check your PostgreSQL connection in `.env`. Ensure PostGIS extension is available:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

### Socket.io: "Authentication required"
The app now sends JWT in socket handshake auth. Ensure user is logged in before connecting.

---

## Architecture Overview

```
Renuir-claude (React Native / Expo)
├── src/api/          ← API client layer (typed, authenticated)
├── src/components/   ← Reusable UI components
├── src/constants/    ← Colors, spacing, typography (matches DESIGN.md)
├── src/hooks/        ← React Query hooks
├── src/lib/          ← Firebase, SecureStore auth service
├── src/navigation/   ← React Navigation stack + tab navigator
├── src/screens/      ← Screen components
├── src/store/        ← Redux Toolkit (auth state)
└── src/types/        ← TypeScript types (single source of truth)

Renuir-backend (Node.js / Express)
├── middleware/       ← auth.js, rateLimiter.js, uploadQuota.js
├── routes/           ← auth, items, claims, conversations, notifications,
│                        organizations, analytics, payments, shipping
├── utils/            ← db.js (pool), pushNotification.js
├── migrations/       ← Knex migration files
└── tests/            ← Jest + supertest integration tests
```
