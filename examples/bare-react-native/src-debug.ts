import { Platform } from 'react-native';
import { initReactNative } from '@debugkit/sdk/react-native';

// Bare React Native. deBug reads model, memory, screen, network and storage details itself with
// react-native-device-info (in this app's dependencies, so it's linked).
export const debug = initReactNative({
  endpoint: Platform.OS === 'android' ? 'http://10.0.2.2:4400/api/ingest' : 'http://localhost:4400/api/ingest',
  ingestKey: 'pk_local',
  app: { id: 'bare-rn-example' },
});
