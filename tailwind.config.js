/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Stock zinc-500 and zinc-600 text sits at 3.99:1 and 2.50:1 on the app's dark panels.
      // These two keep the same order under zinc-400 and clear 4.5:1 on every panel color.
      textColor: { zinc: { 500: '#93939d', 600: '#85858f' } },
    },
  },
  plugins: [],
};
