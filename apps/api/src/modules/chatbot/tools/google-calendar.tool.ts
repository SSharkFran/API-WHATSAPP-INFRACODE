import { google, calendar_v3, Auth } from "googleapis";
import type { GoogleCalendarModuleConfig } from "@infracode/types";

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface CreateEventResult {
  success: boolean;
  eventId?: string;
  htmlLink?: string;
  error?: string;
}

export interface CheckAvailabilityResult {
  success: boolean;
  date: string;
  slots: TimeSlot[];
  error?: string;
}

export class GoogleCalendarTool {
  private readonly config: GoogleCalendarModuleConfig;
  private readonly oauth2Client: Auth.OAuth2Client;

  constructor(config: GoogleCalendarModuleConfig) {
    this.config = config;
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      "http://localhost"
    );
    this.oauth2Client.setCredentials({
      refresh_token: config.refreshToken
    });
  }

  private async getAccessToken(): Promise<string> {
    try {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      return credentials.access_token ?? "";
    } catch (error) {
      console.error("[GoogleCalendar] Erro ao gerar access token:", error);
      throw new Error("Falha ao autenticar com Google Calendar");
    }
  }

  private async getCalendar(): Promise<calendar_v3.Calendar> {
    const accessToken = await this.getAccessToken();
    this.oauth2Client.setCredentials({
      refresh_token: this.config.refreshToken,
      access_token: accessToken
    });
    return google.calendar({ version: "v3", auth: this.oauth2Client });
  }

  async checkAvailability(date: string): Promise<CheckAvailabilityResult> {
    try {
      const calendar = await this.getCalendar();

      const startOfDay = new Date(`${date}T00:00:00`);
      const endOfDay = new Date(`${date}T23:59:59`);

      const response = await calendar.events.list({
        calendarId: this.config.calendarId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime"
      });

      const busySlots = response.data.items ?? [];

      const slots: TimeSlot[] = [];
      const dayStart = new Date(`${date}T09:00:00`);
      const dayEnd = new Date(`${date}T18:00:00`);
      const slotDurationMinutes = 30;

      let currentSlotStart = new Date(dayStart);

      while (currentSlotStart < dayEnd) {
        const currentSlotEnd = new Date(currentSlotStart.getTime() + slotDurationMinutes * 60 * 1000);
        let isBusy = false;

        for (const event of busySlots) {
          const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : null;
          const eventEnd = event.end?.dateTime ? new Date(event.end.dateTime) : null;

          if (eventStart && eventEnd) {
            if (
              (currentSlotStart >= eventStart && currentSlotStart < eventEnd) ||
              (currentSlotEnd > eventStart && currentSlotEnd <= eventEnd) ||
              (currentSlotStart <= eventStart && currentSlotEnd >= eventEnd)
            ) {
              isBusy = true;
              break;
            }
          }
        }

        slots.push({
          start: currentSlotStart.toTimeString().slice(0, 5),
          end: currentSlotEnd.toTimeString().slice(0, 5),
          available: !isBusy
        });

        currentSlotStart = currentSlotEnd;
      }

      return {
        success: true,
        date,
        slots
      };
    } catch (error) {
      console.error("[GoogleCalendar] Erro ao verificar disponibilidade:", error);
      return {
        success: false,
        date,
        slots: [],
        error: error instanceof Error ? error.message : "Erro desconhecido"
      };
    }
  }

  async createEvent(
    summary: string,
    description: string,
    startDateTime: string,
    endDateTime: string
  ): Promise<CreateEventResult> {
    try {
      const calendar = await this.getCalendar();

      const event: calendar_v3.Schema$Event = {
        summary,
        description,
        start: {
          dateTime: startDateTime,
          timeZone: "America/Sao_Paulo"
        },
        end: {
          dateTime: endDateTime,
          timeZone: "America/Sao_Paulo"
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: 24 * 60 },
            { method: "popup", minutes: 30 }
          ]
        }
      };

      const response = await calendar.events.insert({
        calendarId: this.config.calendarId,
        requestBody: event,
        sendUpdates: "all"
      });

      return {
        success: true,
        eventId: response.data.id ?? undefined,
        htmlLink: response.data.htmlLink ?? undefined
      };
    } catch (error) {
      console.error("[GoogleCalendar] Erro ao criar evento:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Erro desconhecido"
      };
    }
  }

  async getAuthUrl(): Promise<string> {
    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events"
      ]
    });
  }

  async getTokensFromCode(code: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expiry_date: number;
  }> {
    const { tokens } = await this.oauth2Client.getToken(code);
    if (!tokens.access_token) {
      throw new Error("Access token não encontrado na resposta");
    }
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date: tokens.expiry_date ?? 0
    };
  }
}
