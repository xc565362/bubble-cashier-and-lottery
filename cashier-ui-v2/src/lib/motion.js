// Animation kill-switch (management request): every framer-motion component
// renders its target state instantly. `initial={false}` mounts directly at
// the animate values (no mount fade/spring) and the zero-duration transition
// keeps any later state change a single step instead of an animation.
import { createElement, forwardRef } from 'react';
import { motion as base, AnimatePresence, MotionConfig } from 'framer-motion';

const wrap = (tag) => forwardRef(function InstantMotion({ initial, transition, children, ...props }, ref) {
  return createElement(base[tag], { ...props, ref, initial: false, transition: { duration: 0 } }, children);
});

export const motion = new Proxy(base, {
  get: (target, tag) => (typeof tag === 'string' && tag in target ? wrap(tag) : target[tag]),
});

export { AnimatePresence, MotionConfig };
