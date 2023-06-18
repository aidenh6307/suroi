import { WebSocket } from "ws";
import {
    PacketType, Actions, ACTIONS_BITS
} from "../../common/src/constants";
import { random, randomBoolean } from "../../common/src/utils/random";
import { SuroiBitStream } from "../../common/src/utils/suroiBitStream";

const config = {
    address: "ws://127.0.0.1:8000/play",
    botCount: 79,
    joinDelay: 50
};

for (let i = 0; i < config.botCount; i++) {
    setTimeout(() => {
        let movingUp = false;
        let movingDown = false;
        let movingLeft = false;
        let movingRight = false;
        let shootStart = false;
        let interact = false;

        const ws = new WebSocket(`${config.address}?name=BOT_${i}`);

        ws.addEventListener("error", console.error);
        ws.addEventListener("open", () => {

            const stream = SuroiBitStream.alloc(4);
            stream.writePacketType(PacketType.Join);
            stream.writeBoolean(false);
            ws.send(stream.buffer.slice(0, Math.ceil(stream.index / 8)));

            setInterval(() => {
                const stream = SuroiBitStream.alloc(128);
                stream.writePacketType(PacketType.Input);
                stream.writeBoolean(movingUp);
                stream.writeBoolean(movingDown);
                stream.writeBoolean(movingLeft);
                stream.writeBoolean(movingRight);

                stream.writeBoolean(shootStart);
                stream.writeBoolean(false);

                if (interact) {
                    stream.writeBits(Actions.Interact, ACTIONS_BITS);
                } else {
                    stream.writeBits(Actions.None, ACTIONS_BITS);
                }
                ws.send(stream.buffer.slice(0, Math.ceil(stream.index / 8)));
            }, 30);
        });
        setInterval(() => {
            movingUp = false;
            movingDown = false;
            movingLeft = false;
            movingRight = false;
            shootStart = randomBoolean();
            interact = randomBoolean();
            const direction: number = random(1, 8);
            switch (direction) {
                case 1:
                    movingUp = true;
                    break;
                case 2:
                    movingDown = true;
                    break;
                case 3:
                    movingLeft = true;
                    break;
                case 4:
                    movingRight = true;
                    break;
                case 5:
                    movingUp = true;
                    movingLeft = true;
                    break;
                case 6:
                    movingUp = true;
                    movingRight = true;
                    break;
                case 7:
                    movingDown = true;
                    movingLeft = true;
                    break;
                case 8:
                    movingDown = true;
                    movingRight = true;
                    break;
            }
        }, 2000);
    }, config.joinDelay * i);
}
