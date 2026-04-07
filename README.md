# AnyWear

AnyWear is an AI-powered virtual try-on and wardrobe management platform designed to revolutionize how users interact with their clothing, daily styling, and fashion purchases. It is built as a cloud-native, serverless-container application utilizing a modern stack (Tauri, React, Node.js, AWS ECS Fargate, Aurora Serverless).

## Core Features

- **Virtual Try-On (VTO) Engine**: Powered by ByteDance's Seedream 5.0, the core VTO engine realistically maps selected garments onto a user's uploaded "base photo," handling multi-garment fusion and pose preservation.
- **Digital Wardrobe Management**: Users can digitize their real-world wardrobe. The platform automatically tags clothing attributes (category, color, fit, etc.) and removes backgrounds using the ZhiPu AI Clothing Recognition Agent. It also supports vector-based visual search to quickly locate items via images.
- **AI Styling & Recommendations**:
  - **Context-Aware Recommendations**: Utilizing the ByteDance doubao-seed-2-0 model alongside hyperlocal weather data (via QWeather), the app provides daily personalized outfit suggestions directly rendered onto the user's avatar.
  - **Conversational AI Stylist**: An interactive chat interface allows users to request outfit ideas using natural language, dynamically generating styled VTO images based on the user's prompt and wardrobe context.
- **Social Sharing**: Users can create social networks, share their digital wardrobes, and even perform proxy try-ons for friends and family based on role-based permissions.
- **Marketplace Integration**: Integrates with third-party retailers to allow users to virtually try on clothes from online stores before purchasing seamlessly through the platform.

## Architecture Highlights

- **Client**: Cross-platform application (Desktop and Mobile) built with Tauri v2, React 19, TypeScript, Vite, and Tailwind CSS v4.
- **Service (Backend)**: A modular monolith deployed on AWS ECS Fargate using a "One Task" unified architecture. Built with Node.js, Hono, Drizzle ORM, and LangGraph.js.
- **Meta Contract**: The `AnyWear-Meta` submodule serves as the single source of truth for OpenAPI specifications and Shared TypeScript interfaces to seamlessly bridge the client and service repositories.
- **Cloud Infrastructure**: Embraces AWS managed services including Cognito (with WAF protection for passwordless OTP), Aurora Serverless (PostgreSQL + pgvector), S3, and EventBridge Scheduler.