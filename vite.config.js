import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served at the site root. If you deploy under a sub-path (e.g. GitHub Pages
  // project pages), set `base` to '/your-repo-name/'.
  base: '/',
  server: {
    host: true, // expose on the LAN so a tablet on the same network can open it
    port: 5173,

    // ----------------------------------------------------------------------
    // Optional: serve THIS app over HTTPS too.
    //
    // You do NOT need this just to talk to TouchDesigner — the signaling
    // connection is wss:// regardless of how this page is served, and
    // http://localhost is already a "secure context" in browsers.
    //
    // Enable it only if you open the page from another device by IP (e.g. a
    // tablet hitting http://192.168.x.x:5173) AND your browser blocks the
    // wss:// upgrade as mixed content. To enable, generate a cert with mkcert
    // (see README) and uncomment:
    //
    // https: {
    //   cert: fs.readFileSync('./tdServer.crt'),
    //   key:  fs.readFileSync('./tdServer.key'),
    // },
    // ----------------------------------------------------------------------
  },
})
