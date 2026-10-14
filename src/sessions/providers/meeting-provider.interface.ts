export type MeetingDetails = {
  title: string;
  description?: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
};

export type CreateMeetingInput = MeetingDetails & {
  /** The host's user id, used to look up their stored OAuth credentials. */
  hostUserId: string;
  attendeeEmails: string[];
};

export type MeetingResult = {
  externalMeetingId: string;
  joinUrl: string;
};

export interface MeetingProvider {
  createMeeting(input: CreateMeetingInput): Promise<MeetingResult>;
  /** Keeps the provider's meeting in step when a session is renamed or rescheduled. */
  updateMeeting(hostUserId: string, externalMeetingId: string, details: MeetingDetails): Promise<void>;
  deleteMeeting(hostUserId: string, externalMeetingId: string): Promise<void>;
  /** A link that opens the meeting as its host, or null to use the join link. Fetched fresh each time. */
  hostUrl(hostUserId: string, externalMeetingId: string): Promise<string | null>;
}
