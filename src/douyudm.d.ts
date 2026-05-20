declare module 'douyudm' {
  export type MessageEventType =
    | 'loginres' | 'chatmsg' | 'uenter' | 'upgrade' | 'rss'
    | 'bc_buy_deserve' | 'ssd' | 'spbc' | 'dgb' | 'gdp' | 'onlinegift'
    | 'ggbb' | 'rankup' | 'ranklist' | 'mrkl' | 'erquizisn'
    | 'blab' | 'rri' | 'synexp' | 'noble_num_info' | 'gbroadcast'
    | 'qausrespond' | 'wiru' | 'wirt' | 'mcspeacsite' | 'rank_change'
    | 'srres' | 'anbc' | 'frank' | 'nlkstatus' | 'pandoraboxinfo'
    | 'ro_game_succ' | 'lucky_wheel_star_pool' | 'tsgs' | 'fswrank'
    | 'tsboxb' | 'cthn' | 'configscreen' | 'rnewbc';

  export type ClientEventName = 'connect' | 'disconnect' | 'error';

  export interface ClientLike {
    readonly roomId: string | number;
    send(message: Record<string, unknown>): void;
    close(): void;
  }

  export type ClientEventHandler = (client: ClientLike, err?: Error) => void;
  export type MessageHandler = (message: Record<string, unknown>, client?: ClientLike) => void;

  export interface ClientOptions {
    ignore?: MessageEventType[];
  }

  export class Client implements ClientLike {
    readonly roomId: string | number;
    constructor(roomId: string | number, opts?: ClientOptions);
    on(event: ClientEventName, cb: ClientEventHandler): this;
    on(event: MessageEventType, cb: MessageHandler): this;
    send(message: Record<string, unknown>): void;
    run(url?: string): void;
    close(): void;
  }
}
