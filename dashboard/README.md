# dashboard

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines Next.js, Self, TRPC, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **Next.js** - Full-stack React framework
- **React Native** - Build mobile apps using React
- **Expo** - Tools for React Native development
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **tRPC** - End-to-end type-safe APIs
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine
- **Authentication** - Better-Auth
- **Turborepo** - Optimized monorepo build system
- **Biome** - Linting and formatting
- **Oxlint** - Oxlint + Oxfmt (linting & formatting)
- **Husky** - Git hooks for code quality

## Getting Started

First, install the dependencies:

```bash
npm install
```

## Database Setup

This project uses PostgreSQL with Drizzle ORM.

1. Start the local PostgreSQL container. It binds host port `10532` by default.
2. Make sure `apps/web/.env` points to `postgresql://postgres:password@localhost:10532/dashboard`.

3. Apply the schema to your database:

```bash
../pr dashboard:db:save-image
../pr dashboard:db:start
../pr dashboard:db:push
```

Then, run the development server:

```bash
../pr dashboard
```

Open [http://localhost:13630](http://localhost:13630) in your browser to see the fullstack application.
Use the Expo Go app to run the mobile application.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@dashboard/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Git Hooks and Formatting

- Initialize hooks: `npm run prepare`
- Run checks: `npm run check`

## Project Structure

```
dashboard/
├── apps/
│   └── web/         # Fullstack application (Next.js)
│   ├── native/      # Mobile application (React Native, Expo)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `npm run dev`: Start all applications in development mode
- `npm run build`: Build all applications
- `npm run dev:web`: Start only the web application
- `npm run check-types`: Check TypeScript types across all apps
- `npm run dev:native`: Start the React Native/Expo development server
- `npm run db:push`: Push schema changes to database
- `npm run db:generate`: Generate database client/types
- `npm run db:migrate`: Run database migrations
- `npm run db:studio`: Open database studio UI
- `npm run check`: Run Biome formatting and linting
