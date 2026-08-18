import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './web/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
