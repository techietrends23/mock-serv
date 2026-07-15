import type { CapturedCall, CaptureSession } from '../types.ts';
import { stableId, nowIso } from '../utils.ts';
import { CaptureController, type ProxyCaptureEvent } from './proxy.ts';
import { proxyEventToCapturedCall } from './flow-parser.ts';
import type { WorkspaceRepository } from '../persistence/sqlite.ts';

export class CaptureSessionManager {
  private capture: CaptureController;
  private repo: WorkspaceRepository;
  private activeSessionId: string | null = null;
  private unbindCapture: (() => void) | null = null;

  constructor(repo: WorkspaceRepository) {
    this.capture = new CaptureController();
    this.repo = repo;
  }

  async createSession(name: string): Promise<CaptureSession> {
    const session: CaptureSession = {
      id: stableId('csession'),
      name,
      status: 'idle',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      callCount: 0
    };
    return this.repo.saveCaptureSession(session);
  }

  async startSession(sessionId: string): Promise<CaptureSession> {
    const session = this.repo.getCaptureSession(sessionId);
    if (!session) throw new Error('Capture session not found');
    if (session.status === 'running') throw new Error('Session is already running');

    this.activeSessionId = sessionId;

    this.unbindCapture = this.capture.onCapture((event: ProxyCaptureEvent) => {
      try {
        const call = proxyEventToCapturedCall(event, sessionId);
        this.repo.insertCapturedCall(call);
      } catch {
      }
    });

    await this.capture.start();

    const updated = this.repo.saveCaptureSession({
      ...session,
      status: 'running',
      updatedAt: nowIso()
    });

    return updated;
  }

  async stopSession(sessionId: string): Promise<CaptureSession> {
    const session = this.repo.getCaptureSession(sessionId);
    if (!session) throw new Error('Capture session not found');

    await this.capture.stop();

    if (this.unbindCapture) {
      this.unbindCapture();
      this.unbindCapture = null;
    }
    this.activeSessionId = null;

    const updated = this.repo.saveCaptureSession({
      ...session,
      status: 'stopped',
      updatedAt: nowIso()
    });

    return updated;
  }

  listSessions(): CaptureSession[] {
    return this.repo.listCaptureSessions();
  }

  getSession(id: string): CaptureSession | undefined {
    return this.repo.getCaptureSession(id);
  }

  deleteSession(id: string): void {
    if (this.activeSessionId === id) {
      this.capture.stop().catch(() => {});
      this.activeSessionId = null;
    }
    this.repo.deleteCaptureSession(id);
  }

  listCalls(sessionId: string): CapturedCall[] {
    return this.repo.listCapturedCalls(sessionId);
  }

  getCall(id: string): CapturedCall | undefined {
    return this.repo.getCapturedCall(id);
  }

  deleteCall(id: string): void {
    this.repo.deleteCapturedCall(id);
  }

  isActive(): boolean {
    return this.activeSessionId !== null;
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    if (this.activeSessionId !== sessionId) throw new Error('Session is not active');
    await this.capture.navigate(url);
  }

  cleanup(): void {
    if (this.unbindCapture) {
      this.unbindCapture();
    }
    this.capture.stop().catch(() => {});
  }
}
