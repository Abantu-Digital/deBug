// Only the one hook we use, so the SDK doesn't need expo-router (and its large tree) to build.
declare module "expo-router" {
  export function usePathname(): string;
}
