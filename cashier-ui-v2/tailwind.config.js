/** @type {import('tailwindcss').Config} */
const themed = (variable) => `rgb(var(${variable}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090c',
          900: themed('--bg'),
          850: themed('--panel-strong'),
          800: themed('--panel'),
          700: '#1d232e',
          600: '#2a3240',
        },
        coral: {
          DEFAULT: '#ff652e',
          soft: themed('--accent-text'),
          deep: '#e04c17',
          glow: 'rgba(255,101,46,0.35)',
        },
        amber: {
          glow: '#ffb25c',
          200: themed('--warn-text-soft'),
          300: themed('--warn-text'),
          400: themed('--warn'),
        },
        emerald: {
          300: themed('--ok-text'),
          400: themed('--ok'),
        },
        red: {
          300: themed('--danger-text'),
          400: themed('--danger'),
          500: themed('--danger-strong'),
        },
        milk: themed('--text'),
        mist: themed('--muted'),
        white: themed('--inv'),
      },
      fontFamily: {
        sans: ['"Inter"', '"SF Pro Display"', '-apple-system', '"PingFang SC"', '"HarmonicOS Sans SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['"SF Mono"', '"JetBrains Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glass: 'var(--shadow-glass)',
        pop: '0 12px 48px rgba(255,101,46,0.22), 0 2px 8px rgba(0,00,0,0.4)',
        card: 'var(--shadow-card)',
        glow: '0 0 24px rgba(255,101,46,0.45)',
      },
      backdropBlur: {
        xs: '2px',
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      keyframes: {
        floaty: {
          '0%,100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-14px)' },
        },
        aurora: {
          '0%': { transform: 'translate(0%,0%) scale(1)' },
          '33%': { transform: 'translate(6%,-4%) scale(1.12)' },
          '66%': { transform: 'translate(-5%,5%) scale(0.94)' },
          '100%': { transform: 'translate(0%,0%) scale(1)' },
        },
        scanline: {
          '0%': { top: '4%' },
          '50%': { top: '92%' },
          '100%': { top: '4%' },
        },
        pulseGlow: {
          '0%,100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        // Decorative motion is disabled on management's request — keep the
        // utilities present (class names still render) but make them no-ops.
        floaty: 'none',
        aurora: 'none',
        scanline: 'none',
        pulseGlow: 'none',
      },
    },
  },
  plugins: [],
};
