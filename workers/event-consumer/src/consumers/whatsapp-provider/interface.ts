export interface SendTemplateMessageParams {
  recipientPhoneNumber: string;
  templateName: string;
  languageCode: string;
  parameters: Array<{ type: 'text'; text: string }>;
}

export interface SendMessageResult {
  providerMessageId: string;
  rawResponse: any;
}

export interface WhatsAppProvider {
  sendTemplateMessage(params: SendTemplateMessageParams): Promise<SendMessageResult>;
}
