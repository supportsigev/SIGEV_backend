import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { UserWithRoles } from '../../../database/types';

interface JwtPayload {
  sub: string;
  email: string;
}

// Evita consultar la BD en cada petición autenticada: los roles/estado de un
// usuario cambian rara vez, así que 60s de TTL es un buen equilibrio entre
// consumo (créditos de Railway) y revocación casi inmediata de accesos.
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX_ENTRIES = 500;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly userCache = new Map<
    string,
    { user: UserWithRoles; expiresAt: number }
  >();

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      // El header Bearer es el mecanismo principal; el query param ?token=
      // existe solo para el stream SSE (EventSource no permite headers).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret') || 'fallback-secret',
    });
  }

  async validate(payload: JwtPayload): Promise<UserWithRoles> {
    const cached = this.userCache.get(payload.sub);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user;
    }
    if (cached) {
      this.userCache.delete(payload.sub);
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, isActive: true },
      include: { roles: true, ally: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado o inactivo');
    }

    if (this.userCache.size >= USER_CACHE_MAX_ENTRIES) {
      this.evictExpired();
    }
    this.userCache.set(payload.sub, {
      user,
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    });

    return user;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.userCache) {
      if (entry.expiresAt <= now) {
        this.userCache.delete(key);
      }
    }
  }
}
