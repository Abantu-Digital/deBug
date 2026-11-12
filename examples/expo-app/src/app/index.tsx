import { deBug } from '@debugkit/sdk/expo';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

// A fake API call that fails the way the demo's login bug does.
async function verifyOtp(): Promise<{ session: { token: string } }> {
  await new Promise((r) => setTimeout(r, 300));
  return { session: { token: 'abc' } };
}

function Bomb(): never {
  throw new Error('Render crash from <Bomb /> on the home screen');
}

export default function HomeScreen() {
  const [status, setStatus] = useState('Tap a button. Events appear on the dashboard at localhost:4400.');
  const [bomb, setBomb] = useState(false);
  if (bomb) return <Bomb />;

  const actions: { label: string; run: () => void | Promise<void> }[] = [
    {
      label: 'Failing login (track + handled error)',
      run: async () => {
        deBug.breadcrumb('ui', 'Tapped Verify');
        try {
          await deBug.track('auth.login', 'submit_otp', async () => {
            const res = (await verifyOtp()) as unknown as { accessToken?: { value: string } };
            return res.accessToken!.value; // TypeError: the API returns `session`, not `accessToken`
          });
        } catch {
          setStatus('Logged a failed login and its TypeError under auth.login.');
        }
      },
    },
    {
      label: 'Custom event (checkout success)',
      run: () => {
        deBug.event('checkout.complete', { flow: 'checkout.payment', outcome: 'success', props: { items: 2 } });
        setStatus('Logged a success event for checkout.payment.');
      },
    },
    {
      label: 'Unhandled promise rejection',
      run: () => {
        void Promise.reject(new Error('Unhandled rejection from the playground'));
        setStatus('Rejected a promise nobody handled.');
      },
    },
    {
      label: 'Render crash (error boundary)',
      run: () => setBomb(true),
    },
    {
      label: 'Flush now',
      run: async () => {
        await deBug.flush();
        setStatus('Flushed the queue.');
      },
    },
  ];

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content}>
          <ThemedText type="title">deBug playground</ThemedText>
          <ThemedText type="small">
            {Platform.OS} · app id expo-example
          </ThemedText>
          {actions.map((a) => (
            <Pressable key={a.label} onPress={a.run} style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]} accessibilityRole="button">
              <ThemedText style={styles.buttonText}>{a.label}</ThemedText>
            </Pressable>
          ))}
          <ThemedText testID="status">{status}</ThemedText>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  content: { padding: 24, gap: 14 },
  button: { backgroundColor: '#c8252f', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16 },
  buttonText: { color: 'white', fontWeight: '600' },
});
