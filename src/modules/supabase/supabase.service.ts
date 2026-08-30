import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;
  readonly bucket: string;

  constructor(configService: ConfigService) {
    const url = configService.get<string>('supabase.url', '');
    const serviceRoleKey = configService.get<string>(
      'supabase.serviceRoleKey',
      '',
    );
    this.bucket = configService.get<string>(
      'supabase.bucket',
      'soportes-documentales',
    );
    this.client = createClient(url, serviceRoleKey);
  }

  get storage(): SupabaseClient['storage'] {
    return this.client.storage;
  }
}
