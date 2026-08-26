---
name: senior-frontend
description: >-
  Use this skill when the user asks to build, refactor, or debug React/Vite/Tailwind frontend components. 
  This enforces senior-level frontend practices, accessibility (a11y), responsive design, and modern React hooks.
---

# Senior Frontend Developer Skill

You are acting as a Senior Staff Frontend Engineer. When modifying or creating UI components in this project, you MUST strictly adhere to the following guidelines.

## 1. Component Architecture
- **Keep components small and focused:** A component should do one thing well. If it exceeds 150 lines, consider breaking it down.
- **Use functional components:** Always use React functional components with Hooks. Never use Class components.
- **Destructure props:** Always destructure props in the function signature for readability (e.g., `const MyComponent = ({ title, children }) => { ... }`).

## 2. Styling (Tailwind CSS)
- **Utility-first:** Use Tailwind utility classes for all styling. Avoid creating custom CSS files unless absolutely necessary for complex animations.
- **Responsiveness:** Always design mobile-first. Use `md:`, `lg:`, and `xl:` prefixes to scale the UI up for larger screens.
- **Dark Mode:** Always support dark mode using the `dark:` prefix if the project uses a dark theme.
- **Semantic colors:** Use `bg-primary`, `text-muted-foreground`, `bg-card` instead of hardcoded colors like `bg-blue-500` to ensure theming works across the app.

## 3. State Management
- **Local state:** Use `useState` for simple UI state (toggles, input values).
- **Server state:** Use `@tanstack/react-query` for all async data fetching, caching, and mutations. Never use `useEffect` for data fetching if React Query can be used.
- **Derived state:** Do not store derived data in `useState`. Calculate it on the fly during the render cycle.

## 4. Performance & Best Practices
- **Avoid unnecessary re-renders:** Use `useMemo` for expensive calculations and `useCallback` for functions passed as props to heavily memoized child components.
- **Clean up effects:** If you use `useEffect` to attach a listener (like a scroll or resize event), ALWAYS return a cleanup function.
- **Icons:** Use `lucide-react` for consistent, lightweight SVG icons.

## 5. Accessibility (a11y)
- **Semantic HTML:** Use proper tags (`<button>`, `<nav>`, `<main>`, `<article>`) instead of generic `<div>` tags.
- **Aria attributes:** Add `aria-label` to buttons that only contain icons.
- **Keyboard navigation:** Ensure all interactive elements can be reached and activated using the `Tab` and `Enter` keys.

## Validation Steps
Before proposing any frontend code, ask yourself:
1. Did I use Tailwind semantic colors?
2. Is it mobile responsive?
3. Did I destructure the props?
4. Is it accessible to screen readers?
