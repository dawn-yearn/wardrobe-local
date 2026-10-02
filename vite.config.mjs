import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loadLocalConfig } from "./scripts/local-config.mjs";
import { createLocalStore } from "./scripts/local-store.mjs";
import { localProfileApi } from "./scripts/local-profile-api.mjs";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { wardrobeOutfitApi } from "./scripts/outfit-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";
import { createVisionProvider, createImageProvider } from "./scripts/providers/index.mjs";

export default defineConfig(({ mode }) => {
  const local = loadLocalConfig(mode);
  const visionProvider = createVisionProvider({ env: local.env });
  const imageProvider = createImageProvider({ env: local.env });
  const store = createLocalStore({ root: local.root, env: local.env, visionProvider, imageProvider });
  const options = { env: local.env, local: store, visionProvider, imageProvider };
  return {
    root: local.root,
    envDir: local.root,
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
    plugins: [react(), localProfileApi(store), wardrobeImportApi(options), wardrobeOutfitApi(options), responsiveImageApi()],
  };
});
