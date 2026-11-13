import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from './lib/motion.js';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <MotionConfig reducedMotion="always">
    <App />
  </MotionConfig>,
);
