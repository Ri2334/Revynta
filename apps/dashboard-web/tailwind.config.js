/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f7ff',
          100: '#e0efff',
          200: '#b8dcff',
          300: '#7abfff',
          400: '#339cff',
          500: '#0070f3', // Custom primary brand color (sleek high-end blue)
          600: '#0059cc',
          700: '#004399',
          800: '#002e66',
          900: '#001a33',
        }
      }
    },
  },
  plugins: [],
}
