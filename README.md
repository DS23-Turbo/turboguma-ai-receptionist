# TurboGuma AI Receptionist

A working end-to-end prototype of an AI-powered phone receptionist for a Polish tire-service use case.

The system handles incoming phone calls in Polish, provides service pricing, checks appointment availability, creates and manages bookings, sends SMS confirmations and reminders, and can transfer the caller to a human employee.

The project was built and tested as a real MVP using external APIs, webhooks and serverless infrastructure.

## What the system can do

During a phone call, the AI receptionist can:

- answer common customer questions in Polish,
- calculate service prices using an external pricing API,
- check real appointment availability,
- create appointments,
- find existing appointments using the caller's phone number,
- cancel appointments,
- reschedule appointments,
- send SMS booking confirmations,
- send automatic SMS reminders before appointments,
- transfer the call to a human employee when necessary.

The AI is not treated as the source of truth for prices or appointment availability. These are retrieved from external systems.

## Architecture

```mermaid
flowchart LR
    Customer["📞 Customer"]

    Retell["Retell AI<br/>Polish Voice Agent"]

    Worker["Cloudflare Worker<br/>Integration Backend"]

    Cal["Cal.com<br/>Appointments & Availability"]

    Pricing["Google Apps Script<br/>Pricing API"]

    Sheets["Google Sheets<br/>Price Database"]

    Zadarma["Zadarma<br/>SMS"]

    Human["👤 Human Employee"]

    Customer -->|Phone call| Retell

    Retell -->|Booking operations| Worker
    Retell -->|Price request| Pricing
    Retell -->|Call transfer| Human

    Pricing -->|Read prices| Sheets

    Worker -->|Availability & bookings| Cal
    Cal -->|Booking webhooks| Worker

    Worker -->|Confirmation & reminder| Zadarma
    Zadarma -->|SMS| Customer
