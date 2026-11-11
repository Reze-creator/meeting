import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'media-protocol',
              test: /node_modules\/(@livekit\/protocol|@bufbuild)/,
              priority: 20,
            },
            {
              name: 'livekit',
              test: /node_modules\/(livekit-client|@livekit|@bufbuild|@protobufjs|protobufjs|sdp|webrtc-adapter)/,
            },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
})
