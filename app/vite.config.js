import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built assets load from file:// inside the Capacitor APK.
export default defineConfig({
  base: './',
  plugins: [react()],
});
