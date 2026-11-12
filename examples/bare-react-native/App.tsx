import './src-debug';
import { deBug, DebugErrorBoundary } from '@debug/sdk/react-native';
import { useState } from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';

function Bomb(): never {
  throw new Error('Render crash from <Bomb /> in the bare React Native example');
}

function Playground() {
  const [bomb, setBomb] = useState(false);
  const [status, setStatus] = useState('Tap a button.');
  if (bomb) return <Bomb />;
  const actions: [string, () => void | Promise<void>][] = [
    ['Failing login', async () => {
      try {
        await deBug.track('auth.login', 'submit', async () => {
          throw new Error('401 Unauthorized: token expired');
        });
      } catch {
        setStatus('Logged a failed login.');
      }
    }],
    ['Render crash', () => setBomb(true)],
  ];
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 28, fontWeight: '700' }}>deBug · bare React Native</Text>
      {actions.map(([label, run]) => (
        <Pressable key={label} onPress={run} style={{ backgroundColor: '#c8252f', padding: 14, borderRadius: 10 }}>
          <Text style={{ color: 'white', fontWeight: '600' }}>{label}</Text>
        </Pressable>
      ))}
      <Text>{status}</Text>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <DebugErrorBoundary flow="app.root" fallback={({ error, reset }) => (
        <View style={{ padding: 24, gap: 12 }}>
          <Text style={{ fontSize: 20, fontWeight: '700' }}>Something went wrong</Text>
          <Text>{error.message}</Text>
          <Pressable onPress={reset}><Text style={{ color: '#c8252f' }}>Try again</Text></Pressable>
        </View>
      )}>
        <Playground />
      </DebugErrorBoundary>
    </SafeAreaView>
  );
}
