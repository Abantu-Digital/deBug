import { Platform } from 'react-native';
import { initExpo } from '@debugkit/sdk/expo';

// Local development: the deBug dashboard in demo mode accepts events at /api/ingest.
// The iOS simulator reaches your Mac at localhost; the Android emulator uses 10.0.2.2.
// In production this is the URL of the ingest function in your own cloud.
const endpoint =
  process.env.EXPO_PUBLIC_DEBUG_ENDPOINT ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:4400/api/ingest' : 'http://localhost:4400/api/ingest');

export const debug = initExpo({
  endpoint,
  ingestKey: process.env.EXPO_PUBLIC_DEBUG_KEY ?? 'pk_local',
  app: { id: 'expo-example', environment: __DEV__ ? 'development' : 'production' },
  captureUnhandledRejections: true, // also in development, for this demo
  flushIntervalMs: 2000,
  debug: true,
});
