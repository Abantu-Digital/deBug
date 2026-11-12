import '@/debug'; // first: start capturing before anything else runs

import { DebugErrorBoundary } from '@debug/sdk/expo';
import { useDebugExpoRouter } from '@debug/sdk/expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Pressable, Text, useColorScheme, View } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

SplashScreen.preventAutoHideAsync();

function CrashScreen({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>Something went wrong</Text>
      <Text style={{ textAlign: 'center', opacity: 0.7 }}>{error.message}</Text>
      <Text style={{ textAlign: 'center', opacity: 0.7 }}>deBug has recorded this crash.</Text>
      <Pressable onPress={reset} style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#c8252f' }}>
        <Text style={{ color: 'white', fontWeight: '600' }}>Try again</Text>
      </Pressable>
    </View>
  );
}

export default function TabLayout() {
  const colorScheme = useColorScheme();
  useDebugExpoRouter(); // a breadcrumb for every screen change
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <DebugErrorBoundary flow="app.root" fallback={(p) => <CrashScreen {...p} />}>
        <AnimatedSplashOverlay />
        <AppTabs />
      </DebugErrorBoundary>
    </ThemeProvider>
  );
}
