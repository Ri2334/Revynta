import { WhatsAppProvider } from './interface.js';
import { MetaWhatsAppProvider } from './meta.js';
import { MockWhatsAppProvider } from './mock.js';
import { config } from '@revynta/config';

export function getWhatsAppProvider(
  phoneNumberId: string,
  accessToken: string,
  options?: { isMock?: boolean; simulatedLatencyMs?: number; simulatedErrorStatus?: number }
): WhatsAppProvider {
  const isMock = options?.isMock ?? (config.env === 'test' || accessToken.startsWith('mock-'));
  
  if (isMock) {
    return new MockWhatsAppProvider(
      phoneNumberId,
      options?.simulatedLatencyMs ?? 0,
      options?.simulatedErrorStatus
    );
  }

  return new MetaWhatsAppProvider(phoneNumberId, accessToken);
}
