/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./*.html", "./**/*.html"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        clinic: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          200: "#99f6e4",
          300: "#5eead4",
          400: "#2dd4bf",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e",
          800: "#115e59",
          900: "#134e4a",
        },
      },
      boxShadow: {
        clinic: "0 4px 6px -1px rgb(15 23 42 / 0.07), 0 10px 24px -8px rgb(15 23 42 / 0.12)",
        "clinic-lg": "0 20px 40px -16px rgb(15 23 42 / 0.18)",
      },
      maxWidth: {
        clinic: "1200px",
        "clinic-queue": "1100px",
      },
    },
  },
  plugins: [],
};
