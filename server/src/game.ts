import { type TemplatedApp, type WebSocket } from "uWebSockets.js";
import { isMainThread, parentPort, workerData } from "worker_threads";
import { GameConstants, KillfeedEventType, KillfeedMessageType, ObjectCategory, PacketType, TeamSize } from "../../common/src/constants";
import { type ExplosionDefinition } from "../../common/src/definitions/explosions";
import { type LootDefinition } from "../../common/src/definitions/loots";
import { MapPings, type MapPingDefinition } from "../../common/src/definitions/mapPings";
import { Obstacles, type ObstacleDefinition } from "../../common/src/definitions/obstacles";
import { SyncedParticles, type SyncedParticleDefinition, type SyncedParticleSpawnerDefinition } from "../../common/src/definitions/syncedParticles";
import { type ThrowableDefinition } from "../../common/src/definitions/throwables";
import { type JoinPacket } from "../../common/src/packets/joinPacket";
import { JoinedPacket } from "../../common/src/packets/joinedPacket";
import { PacketStream, type Packet } from "../../common/src/packets/packetStream";
import { PingPacket } from "../../common/src/packets/pingPacket";
import { type KillFeedMessage } from "../../common/src/packets/updatePacket";
import { CircleHitbox } from "../../common/src/utils/hitbox";
import { EaseFunctions, Geometry, Numeric } from "../../common/src/utils/math";
import { Timeout } from "../../common/src/utils/misc";
import { ItemType, MapObjectSpawnMode, type ReferenceTo, type ReifiableDef } from "../../common/src/utils/objectDefinitions";
import { pickRandomInArray, randomFloat, randomPointInsideCircle, randomRotation } from "../../common/src/utils/random";
import { OBJECT_ID_BITS, SuroiBitStream } from "../../common/src/utils/suroiBitStream";
import { Vec, type Vector } from "../../common/src/utils/vector";
import { Config, SpawnMode } from "./config";
import { Maps } from "./data/maps";
import { type WorkerMessage, WorkerMessages, type GameData } from "./gameManager";
import { Gas } from "./gas";
import { type GunItem } from "./inventory/gunItem";
import { type ThrowableItem } from "./inventory/throwableItem";
import { Map } from "./map";
import { Building } from "./objects/building";
import { Bullet, type DamageRecord, type ServerBulletOptions } from "./objects/bullet";
import { type Emote } from "./objects/emote";
import { Explosion } from "./objects/explosion";
import { type BaseGameObject, type GameObject } from "./objects/gameObject";
import { Loot } from "./objects/loot";
import { Obstacle } from "./objects/obstacle";
import { Parachute } from "./objects/parachute";
import { Player, type PlayerContainer } from "./objects/player";
import { SyncedParticle } from "./objects/syncedParticle";
import { ThrowableProjectile } from "./objects/throwableProj";
import { Team } from "./team";
import { Grid } from "./utils/grid";
import { IDAllocator } from "./utils/idAllocator";
import { Logger, removeFrom } from "./utils/misc";
import { createServer, forbidden, getIP } from "./utils/serverHelpers";
import { cleanUsername } from "./utils/usernameFilter";

export class Game {
    readonly _id: number;
    get id(): number { return this._id; }

    server: TemplatedApp;

    // string = ip, number = expire time
    readonly allowedIPs: globalThis.Map<string, number> = new globalThis.Map();

    readonly simultaneousConnections: Record<string, number> = {};
    joinAttempts: Record<string, number> = {};

    readonly map: Map;
    readonly gas: Gas;
    readonly grid: Grid;

    readonly partialDirtyObjects = new Set<BaseGameObject>();
    readonly fullDirtyObjects = new Set<BaseGameObject>();

    updateObjects = false;

    readonly livingPlayers = new Set<Player>();
    readonly connectedPlayers = new Set<Player>();
    readonly spectatablePlayers: Player[] = [];
    /**
     * New players created this tick
     */
    readonly newPlayers: Player[] = [];
    /**
    * Players deleted this tick
    */
    readonly deletedPlayers: number[] = [];

    readonly maxTeamSize: number;

    readonly teamMode: boolean;

    readonly teams = new (class <T> extends Set<T> {
        private _valueCache?: T[];
        get valueArray(): T[] {
            /*
                this rule is stupid and a skill issue filter
                "It's also possible that the intent was to use a comparison operator such as == and that this code is an error."

                anyone who confuses "??=" for "==" should consult an eye doctor
            */
            // eslint-disable-next-line no-return-assign
            return this._valueCache ??= [...super.values()];
        }

        add(value: T): this {
            super.add(value);
            this._valueCache = undefined;
            return this;
        }

        delete(value: T): boolean {
            const ret = super.delete(value);
            this._valueCache = undefined;
            return ret;
        }

        clear(): void {
            super.clear();
            this._valueCache = undefined;
        }

        values(): IterableIterator<T> {
            const iterator = this.values();
            this._valueCache ??= [...iterator];

            return iterator;
        }
    })<Team>();

    private _nextTeamID = -1;
    get nextTeamID(): number { return ++this._nextTeamID; }

    readonly customTeams: globalThis.Map<string, Team> = new globalThis.Map<string, Team>();

    readonly explosions: Explosion[] = [];
    readonly emotes: Emote[] = [];

    /**
     * All bullets that currently exist
     */
    readonly bullets = new Set<Bullet>();
    /**
     * All bullets created this tick
     */
    readonly newBullets: Bullet[] = [];

    /**
     * All kill feed messages this tick
     */
    readonly killFeedMessages: KillFeedMessage[] = [];

    /**
     * All airdrops
     */
    readonly airdrops: Airdrop[] = [];

    /**
     * All planes this tick
     */
    readonly planes: Array<{
        readonly position: Vector
        readonly direction: number
    }> = [];

    /**
     * All map pings this tick
     */
    readonly mapPings: Array<{
        readonly definition: MapPingDefinition
        readonly position: Vector
        readonly playerId?: number
    }> = [];

    private readonly _timeouts = new Set<Timeout>();

    addTimeout(callback: () => void, delay = 0): Timeout {
        const timeout = new Timeout(callback, this.now + delay);
        this._timeouts.add(timeout);
        return timeout;
    }

    private _started = false;
    allowJoin = false;
    over = false;
    stopped = false;

    startedTime = Number.MAX_VALUE; // Default of Number.MAX_VALUE makes it so games that haven't started yet are joined first

    startTimeout?: Timeout;

    aliveCountDirty = false;

    /**
     * The value of `Date.now()`, as of the start of the tick.
     */
    private _now = Date.now();
    get now(): number { return this._now; }

    tickTimes: number[] = [];

    constructor() {
        this._id = workerData.id;
        this.maxTeamSize = workerData.maxTeamSize;
        this.teamMode = this.maxTeamSize > TeamSize.Solo;

        const start = Date.now();

        parentPort?.on("message", (message: WorkerMessage) => {
            switch (message.type) {
                case WorkerMessages.AllowIP: {
                    this.allowedIPs.set(message.ip, this.now + 5000);
                    parentPort?.postMessage({
                        type: WorkerMessages.IPAllowed,
                        ip: message.ip
                    });
                    break;
                }
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const This = this;

        this.server = createServer().ws("/play", {
            idleTimeout: 30,

            /**
             * Upgrade the connection to WebSocket.
             */
            upgrade(res, req, context) {
                /* eslint-disable-next-line @typescript-eslint/no-empty-function */
                res.onAborted((): void => { });

                const ip = getIP(res, req);

                //
                // Rate limits
                //
                if (Config.protection) {
                    const { maxSimultaneousConnections, maxJoinAttempts } = Config.protection;
                    const { simultaneousConnections, joinAttempts } = This;

                    if (
                        (simultaneousConnections[ip] >= (maxSimultaneousConnections ?? Infinity)) ||
                        (joinAttempts[ip] >= (maxJoinAttempts?.count ?? Infinity))
                    ) {
                        Logger.log(`Game ${This.id} | Rate limited: ${ip}`);
                        forbidden(res);
                        return;
                    } else {
                        if (maxSimultaneousConnections) {
                            simultaneousConnections[ip] = (simultaneousConnections[ip] ?? 0) + 1;
                            Logger.log(`Game ${This.id} | ${simultaneousConnections[ip]}/${Config.protection.maxSimultaneousConnections} simultaneous connections: ${ip}`);
                        }
                        if (maxJoinAttempts) {
                            joinAttempts[ip] = (joinAttempts[ip] ?? 0) + 1;
                            Logger.log(`Game ${This.id} | ${joinAttempts[ip]}/${maxJoinAttempts.count} join attempts in the last ${maxJoinAttempts.duration} ms: ${ip}`);
                        }
                    }
                }

                const searchParams = new URLSearchParams(req.getQuery());

                //
                // Ensure IP is allowed
                //
                if (!This.allowedIPs.has(ip) || This.allowedIPs.get(ip)! < This.now) {
                    forbidden(res);
                    return;
                }

                //
                // Validate and parse role and name color
                //
                const password = searchParams.get("password");
                const givenRole = searchParams.get("role");
                let role: string | undefined;
                let isDev = false;

                let nameColor: number | undefined;
                if (
                    password !== null &&
                    givenRole !== null &&
                    givenRole in Config.roles &&
                    Config.roles[givenRole].password === password
                ) {
                    role = givenRole;
                    isDev = Config.roles[givenRole].isDev ?? false;

                    if (isDev) {
                        try {
                            const colorString = searchParams.get("nameColor");
                            if (colorString) nameColor = Numeric.clamp(parseInt(colorString), 0, 0xffffff);
                        } catch {}
                    }
                }

                //
                // Upgrade the connection
                //
                res.upgrade(
                    {
                        teamID: searchParams.get("teamID") ?? undefined,
                        autoFill: Boolean(searchParams.get("autoFill")),
                        player: undefined,
                        ip,
                        role,
                        isDev,
                        nameColor,
                        lobbyClearing: searchParams.get("lobbyClearing") === "true",
                        weaponPreset: searchParams.get("weaponPreset") ?? ""
                    },
                    req.getHeader("sec-websocket-key"),
                    req.getHeader("sec-websocket-protocol"),
                    req.getHeader("sec-websocket-extensions"),
                    context
                );
            },

            /**
             * Handle opening of the socket.
             * @param socket The socket being opened.
             */
            open(socket: WebSocket<PlayerContainer>) {
                const data = socket.getUserData();
                data.player = This.addPlayer(socket);
                // data.player.sendGameOverPacket(false); // uncomment to test game over screen
            },

            /**
             * Handle messages coming from the socket.
             * @param socket The socket in question.
             * @param message The message to handle.
             */
            message(socket: WebSocket<PlayerContainer>, message) {
                const stream = new SuroiBitStream(message);
                try {
                    const player = socket.getUserData().player;
                    if (player === undefined) return;
                    This.onMessage(stream, player);
                } catch (e) {
                    console.warn("Error parsing message:", e);
                }
            },

            /**
             * Handle closing of the socket.
             * @param socket The socket being closed.
             */
            close(socket: WebSocket<PlayerContainer>) {
                const data = socket.getUserData();
                if (Config.protection) This.simultaneousConnections[data.ip!]--;
                const { player } = data;
                if (!player) return;
                Logger.log(`Game ${This.id} | "${player.name}" left`);
                This.removePlayer(player);
            }
        }).listen(Config.host, Config.port + this.id + 1, (): void => {
            Logger.log(`Game ${this.id} | Listening on ${Config.host}:${Config.port + this.id + 1}`);
        });

        if (Config.protection?.maxJoinAttempts) {
            setInterval((): void => {
                this.joinAttempts = {};
            }, Config.protection.maxJoinAttempts.duration);
        }

        const map = Maps[Config.mapName];
        this.grid = new Grid(this, map.width, map.height);
        this.map = new Map(this, Config.mapName);

        this.gas = new Gas(this);

        this.setGameData({ allowJoin: true });

        Logger.log(`Game ${this.id} | Created in ${Date.now() - start} ms`);

        // Start the tick loop
        this.tick();
    }

    onMessage(stream: SuroiBitStream, player: Player): void {
        const packetStream = new PacketStream(stream);
        while (true) {
            const packet = packetStream.readPacket();
            if (packet === undefined) break;
            this.onPacket(packet, player);
        }
    }

    onPacket(packet: Packet, player: Player): void {
        switch (packet.type) {
            case PacketType.Join: {
                this.activatePlayer(player, packet);
                break;
            }
            case PacketType.Input: {
                // Ignore input packets from players that haven't finished joining, dead players, and if the game is over
                if (!player.joined || player.dead || player.game.over) return;
                player.processInputs(packet);
                break;
            }
            case PacketType.Spectate: {
                player.spectate(packet);
                break;
            }
            case PacketType.Ping: {
                if (Date.now() - player.lastPingTime < 4000) return;
                player.lastPingTime = Date.now();
                const stream = new PacketStream(SuroiBitStream.alloc(8));
                stream.serializePacket(new PingPacket());
                player.sendData(stream.getBuffer());
                break;
            }
        }
    }

    tick(): void {
        this._now = Date.now();

        // execute timeouts
        for (const timeout of this._timeouts) {
            if (timeout.killed) {
                this._timeouts.delete(timeout);
                continue;
            }

            if (this.now > timeout.end) {
                timeout.callback();
                this._timeouts.delete(timeout);
            }
        }

        for (const loot of this.grid.pool.getCategory(ObjectCategory.Loot)) {
            loot.update();
        }

        for (const parachute of this.grid.pool.getCategory(ObjectCategory.Parachute)) {
            parachute.update();
        }

        for (const projectile of this.grid.pool.getCategory(ObjectCategory.ThrowableProjectile)) {
            projectile.update();
        }

        for (const syncedParticle of this.grid.pool.getCategory(ObjectCategory.SyncedParticle)) {
            syncedParticle.update();
        }

        // Update bullets
        let records: DamageRecord[] = [];
        for (const bullet of this.bullets) {
            records = records.concat(bullet.update());

            if (bullet.dead) {
                if (bullet.definition.onHitExplosion && !bullet.reflected) {
                    this.addExplosion(bullet.definition.onHitExplosion, bullet.position, bullet.shooter);
                }
                this.bullets.delete(bullet);
            }
        }

        // Do the damage after updating all bullets
        // This is to make sure bullets that hit the same object on the same tick will die so they don't de-sync with the client
        // Example: a shotgun insta killing a crate, in the client all bullets will hit the crate
        // while on the server, without this, some bullets won't because the first bullets will kill the crate
        for (const { object, damage, source, weapon, position } of records) {
            object.damage(damage, source, weapon, position);
        }

        // Handle explosions
        for (const explosion of this.explosions) {
            explosion.explode();
        }

        // Update gas
        this.gas.tick();

        // First loop over players: movement, animations, & actions
        for (const player of this.grid.pool.getCategory(ObjectCategory.Player)) {
            if (!player.dead) player.update();
        }

        // Cache objects serialization
        for (const partialObject of this.partialDirtyObjects) {
            if (!this.fullDirtyObjects.has(partialObject)) {
                partialObject.serializePartial();
            }
        }
        for (const fullObject of this.fullDirtyObjects) {
            fullObject.serializeFull();
        }

        // Second loop over players: calculate visible objects & send updates
        for (const player of this.connectedPlayers) {
            if (!player.joined) continue;
            player.secondUpdate();
        }

        // Third loop over players: clean up after all packets have been sent
        for (const player of this.connectedPlayers) {
            if (!player.joined) continue;

            player.postPacket();
        }

        // Reset everything
        this.fullDirtyObjects.clear();
        this.partialDirtyObjects.clear();
        this.newBullets.length = 0;
        this.explosions.length = 0;
        this.emotes.length = 0;
        this.newPlayers.length = 0;
        this.deletedPlayers.length = 0;
        this.killFeedMessages.length = 0;
        this.planes.length = 0;
        this.mapPings.length = 0;
        this.aliveCountDirty = false;
        this.gas.dirty = false;
        this.gas.completionRatioDirty = false;
        this.updateObjects = false;

        // Winning logic
        if (
            this._started &&
            !this.over &&
            (
                this.teamMode
                    ? this.aliveCount <= this.maxTeamSize && new Set([...this.livingPlayers].map(p => p.teamID)).size <= 1
                    : this.aliveCount === 1
            )
        ) {
            for (const player of this.livingPlayers) {
                const { movement } = player;
                movement.up = false;
                movement.down = false;
                movement.left = false;
                movement.right = false;
                player.attacking = false;
                player.sendEmote(player.loadout.emotes[4]);
                player.sendGameOverPacket(true);
            }

            this.setGameData({ allowJoin: false, over: true });

            // End the game in 1 second
            this.addTimeout(() => {
                this.server.close();
                this.setGameData({ stopped: true });
            }, 1000);
        }

        // Record performance and start the next tick
        // THIS TICK COUNTER IS WORKING CORRECTLY!
        // It measures the time it takes to calculate a tick, not the time between ticks.
        const tickTime = Date.now() - this.now;
        this.tickTimes.push(tickTime);

        if (this.tickTimes.length >= 200) {
            const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;
            Logger.log(`Game ${this._id} | Avg ms/tick: ${mspt.toFixed(2)} | Load: ${((mspt / GameConstants.msPerTick) * 100).toFixed(1)}%`);
            this.tickTimes = [];
        }

        if (!this.stopped) {
            setTimeout(this.tick.bind(this), GameConstants.msPerTick - tickTime);
        }
    }

    setGameData(data: Partial<GameData>): void {
        for (const [key, value] of Object.entries(data) as Array<[keyof this, this[keyof this]]>) this[key] = value;
        this.updateGameData(data);
    }

    updateGameData(data: Partial<GameData>): void {
        parentPort?.postMessage({ type: WorkerMessages.UpdateGameData, data } satisfies WorkerMessage);
    }

    private _killLeader: Player | undefined;
    get killLeader(): Player | undefined { return this._killLeader; }

    updateKillLeader(player: Player): void {
        const oldKillLeader = this._killLeader;

        if (player.kills > (this._killLeader?.kills ?? (GameConstants.player.killLeaderMinKills - 1)) && !player.dead) {
            this._killLeader = player;

            if (oldKillLeader !== this._killLeader) {
                this._sendKillFeedMessage(KillfeedMessageType.KillLeaderAssigned);
            }
        } else if (player === oldKillLeader) {
            this._sendKillFeedMessage(KillfeedMessageType.KillLeaderUpdated);
        }
    }

    killLeaderDead(killer?: Player): void {
        this._sendKillFeedMessage(KillfeedMessageType.KillLeaderDead, { eventType: KillfeedEventType.NormalTwoParty, attackerId: killer?.id });
        let newKillLeader: Player | undefined;
        for (const player of this.livingPlayers) {
            if (player.kills > (newKillLeader?.kills ?? (GameConstants.player.killLeaderMinKills - 1)) && !player.dead) {
                newKillLeader = player;
            }
        }
        this._killLeader = newKillLeader;
        this._sendKillFeedMessage(KillfeedMessageType.KillLeaderAssigned);
    }

    private _sendKillFeedMessage(messageType: KillfeedMessageType, options?: Partial<Omit<KillFeedMessage, "messageType" | "playerID" | "kills">>): void {
        if (this._killLeader === undefined) return;
        this.killFeedMessages.push({
            messageType,
            victimId: this._killLeader.id,
            attackerKills: this._killLeader.kills,
            ...options
        });
    }

    addPlayer(socket: WebSocket<PlayerContainer>): Player {
        let spawnPosition = Vec.create(this.map.width / 2, this.map.height / 2);

        let team: Team | undefined;
        if (this.teamMode) {
            const { teamID, autoFill } = socket.getUserData();

            if (teamID) {
                if (this.customTeams.has(teamID)) {
                    team = this.customTeams.get(teamID);
                } else {
                    this.teams.add(team = new Team(this.nextTeamID, autoFill));
                    this.customTeams.set(teamID, team);
                }
            } else {
                const vacantTeams = this.teams.valueArray.filter(
                    team =>
                        team.autoFill &&
                        team.players.length < this.maxTeamSize &&
                        team.hasLivingPlayers()
                );
                if (vacantTeams.length) {
                    team = pickRandomInArray(vacantTeams);
                } else {
                    this.teams.add(team = new Team(this.nextTeamID));
                }
            }
        }

        switch (Config.spawn.mode) {
            case SpawnMode.Normal: {
                const hitbox = new CircleHitbox(5);
                const gasPosition = this.gas.currentPosition;
                const gasRadius = this.gas.newRadius ** 2;
                const teamPosition = this.teamMode ? pickRandomInArray(team!.players)?.position : undefined;

                let foundPosition = false;
                let tries = 0;
                while (!foundPosition && tries < 100) {
                    // Find a random position
                    spawnPosition = this.map.getRandomPosition(
                        hitbox,
                        {
                            maxAttempts: 500,
                            spawnMode: MapObjectSpawnMode.GrassAndSand,
                            getPosition: this.teamMode && teamPosition
                                ? () => randomPointInsideCircle(teamPosition, 20, 10)
                                : undefined,
                            collides: (position) => Geometry.distanceSquared(position, gasPosition) >= gasRadius
                        }
                    ) ?? spawnPosition;

                    // Ensure the position is at least 50 units from other players
                    const radiusHitbox = new CircleHitbox(50, spawnPosition);
                    for (const object of this.grid.intersectsHitbox(radiusHitbox)) {
                        if (object instanceof Player && (!this.teamMode || !team!.players.includes(object))) {
                            foundPosition = false;
                        }
                    }
                    tries++;
                }
                break;
            }
            case SpawnMode.Radius: {
                spawnPosition = randomPointInsideCircle(
                    Config.spawn.position,
                    Config.spawn.radius
                );
                break;
            }
            case SpawnMode.Fixed: {
                spawnPosition = Config.spawn.position;
                break;
            }
            // No case for SpawnMode.Center because that's the default
        }

        // Player is added to the players array when a JoinPacket is received from the client
        return new Player(this, socket, spawnPosition, team);
    }

    // Called when a JoinPacket is sent by the client
    activatePlayer(player: Player, packet: JoinPacket): void {
        player.name = cleanUsername(packet.name);

        player.isMobile = packet.isMobile;
        const skin = packet.skin;
        if (
            skin.itemType === ItemType.Skin &&
            !skin.hideFromLoadout &&
            ((skin.roleRequired ?? player.role) === player.role)
        ) {
            player.loadout.skin = skin;
        }

        const badge = packet.badge;
        if (badge && (!badge.roles || (player.role !== undefined && (Array.isArray(badge.roles) ? badge.roles?.includes(player.role) : badge.roles === player.role)))) {
            player.loadout.badge = packet.badge;
        }
        player.loadout.emotes = packet.emotes;

        this.livingPlayers.add(player);
        this.spectatablePlayers.push(player);
        this.connectedPlayers.add(player);
        this.newPlayers.push(player);
        this.grid.addObject(player);
        player.setDirty();
        this.aliveCountDirty = true;
        this.updateObjects = true;
        this.updateGameData({ aliveCount: this.aliveCount });

        player.joined = true;

        const joinedPacket = new JoinedPacket();
        joinedPacket.protocolVersion = GameConstants.protocolVersion;
        joinedPacket.maxTeamSize = this.maxTeamSize;
        joinedPacket.teamID = player.teamID ?? 0;
        joinedPacket.emotes = player.loadout.emotes;
        player.sendPacket(joinedPacket);

        player.sendData(this.map.buffer);

        this.addTimeout(() => { player.disableInvulnerability(); }, 5000);

        if (
            (this.teamMode ? this.teams.size : this.aliveCount) > 1 &&
            !this._started &&
            this.startTimeout === undefined
        ) {
            this.startTimeout = this.addTimeout(() => {
                this._started = true;
                this.setGameData({ startedTime: this.now });
                this.gas.advanceGasStage();

                this.addTimeout(() => {
                    parentPort?.postMessage({ type: WorkerMessages.CreateNewGame });
                    Logger.log(`Game ${this.id} | Preventing new players from joining`);
                    this.setGameData({ allowJoin: false });
                }, Config.preventJoinAfter);
            }, 3000);
        }

        Logger.log(`Game ${this.id} | "${player.name}" joined`);
    }

    removePlayer(player: Player): void {
        player.disconnected = true;
        this.aliveCountDirty = true;
        this.connectedPlayers.delete(player);

        if (player.canDespawn) {
            this.livingPlayers.delete(player);
            this.removeObject(player);
            this.deletedPlayers.push(player.id);
            removeFrom(this.spectatablePlayers, player);
            this.updateGameData({ aliveCount: this.aliveCount });

            if (this.teamMode) {
                player.team?.removePlayer(player);
            }

            if (player.beingRevivedBy) {
                player.beingRevivedBy.action?.cancel();
            }
        } else {
            player.rotation = 0;
            player.movement.up = player.movement.down = player.movement.left = player.movement.right = false;
            player.attacking = false;
            player.setPartialDirty();

            if (this.teamMode && this.now - player.joinTime < 10000) {
                player.team?.removePlayer(player);
            }
        }

        if (player.spectating !== undefined) {
            player.spectating.spectators.delete(player);
        }

        if (this.aliveCount < 2) {
            this.startTimeout?.kill();
            this.startTimeout = undefined;
        }

        try {
            player.socket.close();
        } catch (e) { }
    }

    /**
     * Adds a `Loot` item to the game world
     * @param definition The type of loot to add. Prefer passing `LootDefinition` if possible
     * @param position The position to spawn this loot at
     * @param count Optionally define an amount of this loot (note that this does not equate spawning
     * that many `Loot` objects, but rather how many the singular `Loot` object will contain)
     * @returns The created loot object
     */
    addLoot(definition: ReifiableDef<LootDefinition>, position: Vector, count?: number): Loot {
        const loot = new Loot(
            this,
            definition,
            position,
            count
        );

        this.grid.addObject(loot);
        return loot;
    }

    removeLoot(loot: Loot): void {
        loot.dead = true;
        this.removeObject(loot);
    }

    addBullet(source: GunItem | Explosion, shooter: GameObject, options: ServerBulletOptions): Bullet {
        const bullet = new Bullet(
            this,
            source,
            shooter,
            options
        );

        this.bullets.add(bullet);
        this.newBullets.push(bullet);

        return bullet;
    }

    addExplosion(type: ReferenceTo<ExplosionDefinition> | ExplosionDefinition, position: Vector, source: GameObject): Explosion {
        const explosion = new Explosion(this, type, position, source);
        this.explosions.push(explosion);
        return explosion;
    }

    addProjectile(definition: ThrowableDefinition, position: Vector, source: ThrowableItem): ThrowableProjectile {
        const projectile = new ThrowableProjectile(this, position, definition, source);
        this.grid.addObject(projectile);
        return projectile;
    }

    removeProjectile(projectile: ThrowableProjectile): void {
        this.removeObject(projectile);
        projectile.dead = true;
    }

    addSyncedParticle(definition: SyncedParticleDefinition, position: Vector): SyncedParticle {
        const syncedParticle = new SyncedParticle(this, definition, position);
        this.grid.addObject(syncedParticle);
        return syncedParticle;
    }

    removeSyncedParticle(syncedParticle: SyncedParticle): void {
        this.removeObject(syncedParticle);
        syncedParticle.dead = true;
    }

    addSyncedParticles(particles: SyncedParticleSpawnerDefinition, position: Vector): void {
        const particleDef = SyncedParticles.fromString(particles.type);
        const { spawnRadius, count, deployAnimation } = particles;

        const duration = deployAnimation?.duration;
        const circOut = EaseFunctions.cubicOut;

        const setParticleTarget = duration
            ? (particle: SyncedParticle, target: Vector) => {
                particle.setTarget(target, duration, circOut);
            }
            : (particle: SyncedParticle, target: Vector) => {
                particle._position = target;
            };

        const spawnParticles = (amount = 1): void => {
            for (let i = 0; i++ < amount; i++) {
                setParticleTarget(
                    this.addSyncedParticle(
                        particleDef,
                        position
                    ),
                    Vec.add(
                        Vec.fromPolar(
                            randomRotation(),
                            randomFloat(0, spawnRadius)
                        ),
                        position
                    )
                );
            }
        };

        if (deployAnimation?.staggering) {
            const staggering = deployAnimation.staggering;
            const initialAmount = staggering.initialAmount ?? 0;

            spawnParticles(initialAmount);

            const addTimeout = this.addTimeout.bind(this);
            const addParticles = spawnParticles.bind(null, staggering.spawnPerGroup);
            const delay = staggering.delay;

            for (let i = initialAmount, j = 1; i < count; i++, j++) {
                addTimeout(addParticles, j * delay);
            }
        } else {
            spawnParticles(particles.count);
        }
    }

    /**
     * Delete an object and give the id back to the allocator
     * @param object The object to delete
     */
    removeObject(object: GameObject): void {
        this.grid.removeObject(object);
        this.idAllocator.give(object.id);
        this.updateObjects = true;
    }

    summonAirdrop(position: Vector): void {
        const crateDef = Obstacles.fromString("airdrop_crate_locked");
        const crateHitbox = (crateDef.spawnHitbox ?? crateDef.hitbox).clone();
        let thisHitbox = crateHitbox.clone();

        let collided = true;
        let attempts = 0;

        while (collided && attempts < 500) {
            attempts++;
            collided = false;

            for (const airdrop of this.airdrops) {
                thisHitbox = crateHitbox.transform(position);
                const thatHitbox = (airdrop.type.spawnHitbox ?? airdrop.type.hitbox).transform(airdrop.position);

                if (thisHitbox.collidesWith(thatHitbox)) {
                    collided = true;
                    thisHitbox.resolveCollision(thatHitbox);
                }
                position = thisHitbox.getCenter();
                if (collided) break;
            }

            thisHitbox = crateHitbox.transform(position);

            for (const object of this.grid.intersectsHitbox(thisHitbox)) {
                if (
                    object instanceof Obstacle &&
                    !object.dead &&
                    object.definition.indestructible &&
                    object.spawnHitbox.collidesWith(thisHitbox)
                ) {
                    collided = true;
                    thisHitbox.resolveCollision(object.spawnHitbox);
                }
                position = thisHitbox.getCenter();
            }

            // second loop, buildings
            for (const object of this.grid.intersectsHitbox(thisHitbox)) {
                if (
                    object instanceof Building &&
                    object.scopeHitbox &&
                    object.definition.wallsToDestroy === Infinity
                ) {
                    const hitbox = object.scopeHitbox.clone();
                    hitbox.scale(1.5);
                    if (!thisHitbox.collidesWith(hitbox)) continue;
                    collided = true;
                    thisHitbox.resolveCollision(object.scopeHitbox);
                }
                position = thisHitbox.getCenter();
            }

            const { min, max } = thisHitbox.toRectangle();
            const width = max.x - min.x;
            const height = max.y - min.y;
            position.x = Numeric.clamp(position.x, width, this.map.width - width);
            position.y = Numeric.clamp(position.y, height, this.map.height - height);
        }

        const direction = randomRotation();

        const planePos = Vec.add(
            position,
            Vec.fromPolar(direction, -GameConstants.maxPosition)
        );

        const airdrop = { position, type: crateDef };

        this.airdrops.push(airdrop);

        this.planes.push({ position: planePos, direction });

        this.addTimeout(() => {
            const parachute = new Parachute(this, position, airdrop);
            this.grid.addObject(parachute);
            this.mapPings.push({
                definition: MapPings.fromString("airdrop_ping"),
                position
            });
        }, GameConstants.airdrop.flyTime);
    }

    get aliveCount(): number {
        return this.livingPlayers.size;
    }

    idAllocator = new IDAllocator(OBJECT_ID_BITS);

    get nextObjectID(): number {
        return this.idAllocator.takeNext();
    }
}

export interface Airdrop {
    readonly position: Vector
    readonly type: ObstacleDefinition
}

// eslint-disable-next-line no-new
if (!isMainThread) new Game();
