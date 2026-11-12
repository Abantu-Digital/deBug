import DeviceInfo from 'react-native-device-info';
import { Platform } from 'react-native';
import { initReactNative } from '@debug/sdk/react-native';

// Bare React Native: pass react-native-device-info for model, app version and memory.
// Without it you still get OS, OS version, engine and (on Android) model/brand from react-native.
export const debug = initReactNative({
  endpoint: Platform.OS === 'android' ? 'http://10.0.2.2:4400/api/ingest' : 'http://localhost:4400/api/ingest',
  ingestKey: 'pk_local',
  app: { id: 'bare-rn-example' },
  deviceInfo: DeviceInfo,
});
