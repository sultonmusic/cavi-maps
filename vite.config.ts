import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import {fileURLToPath} from 'node:url';
// ATLAS_BASE=/cavi-maps/ builds the copy served from GitHub Pages; Firebase keeps the root.
export default defineConfig({base:process.env.ATLAS_BASE||'/',plugins:[react()],resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url))}},css:{postcss:{plugins:[tailwindcss()]}},server:{host:'0.0.0.0',watch:{ignored:['**/public/**','**/dist/**']}},build:{outDir:'dist'}});
