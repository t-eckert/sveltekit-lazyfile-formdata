import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: { host: '127.0.0.1', port: 5199, strictPort: true },
	plugins: [
		sveltekit({
			compilerOptions: { runes: true },
			adapter: adapter(),
			experimental: { remoteFunctions: true }
		})
	]
});
