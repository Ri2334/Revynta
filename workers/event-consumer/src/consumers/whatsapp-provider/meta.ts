import { WhatsAppProvider, SendTemplateMessageParams, SendMessageResult } from './interface.js';
import { logger } from '@revynta/observability';

export class MetaWhatsAppProvider implements WhatsAppProvider {
  constructor(
    private phoneNumberId: string,
    private accessToken: string,
    private apiVersion = 'v20.0',
    private baseUrl = 'https://graph.facebook.com'
  ) {}

  async sendTemplateMessage(params: SendTemplateMessageParams): Promise<SendMessageResult> {
    const url = `${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`;
    
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.recipientPhoneNumber,
      type: 'template',
      template: {
        name: params.templateName,
        language: {
          code: params.languageCode,
        },
        components: [
          {
            type: 'body',
            parameters: params.parameters,
          },
        ],
      },
    };

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000), // 10s request timeout
      });

      const latencyMs = Date.now() - startTime;
      const data: any = await response.json();

      if (!response.ok) {
        logger.error(
          { url, status: response.status, body: data, latencyMs },
          'Meta WhatsApp Cloud API request failed'
        );

        const isRateLimit = response.status === 429;
        const isServerErr = response.status >= 500;
        
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

        const err: any = new Error(
          data.error?.message || `Meta WhatsApp API error: Status ${response.status}`
        );
        err.status = response.status;
        err.isTransient = isRateLimit || isServerErr;
        err.retryAfter = retryAfter;
        err.code = data.error?.code;
        err.subcode = data.error?.error_subcode;
        throw err;
      }

      const messageId = data.messages?.[0]?.id;
      if (!messageId) {
        throw new Error('Meta WhatsApp Cloud API response missing message ID');
      }

      return {
        providerMessageId: messageId,
        rawResponse: data,
      };
    } catch (error: any) {
      if (error.name === 'TimeoutError') {
        const timeoutErr: any = new Error('Meta WhatsApp Cloud API request timed out');
        timeoutErr.isTransient = true;
        throw timeoutErr;
      }
      throw error;
    }
  }
}
