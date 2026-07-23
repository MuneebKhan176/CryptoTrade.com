const { WebSocketServer } = require("ws");

const chatGateway = require("./chatrooms_ws");
const marketGateway = require("./marketData_ws");
const futuresGateway = require("./futuresLive_ws"); // sibling file, already in Web_Sockets/

function attachWebSocketManager(server) {

    const chatWss = new WebSocketServer({ noServer: true });
    const marketWss = new WebSocketServer({ noServer: true });
    const futuresWss = new WebSocketServer({ noServer: true });

    chatGateway.initialize(chatWss);
    marketGateway.initialize(marketWss);
    futuresGateway.initialize(futuresWss); // wires engineEvents('liveTick'/'execution'/'liquidation'/'fundingApplied'/'orderBookUpdate') to per-user sockets

    server.on("upgrade", (req, socket, head) => {

        let pathname;

        try {
            pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
        }
        catch (err) {
            socket.destroy();
            return;
        }

        switch (pathname) {

            case "/ws/chat":

                chatWss.handleUpgrade(req, socket, head, (ws) => {
                    chatWss.emit("connection", ws, req);
                });

                break;

            case "/ws/market-data":

                marketWss.handleUpgrade(req, socket, head, (ws) => {
                    marketWss.emit("connection", ws, req);
                });

                break;

            case futuresGateway.WS_PATH: // "/ws/futures-data" — sourced from the gateway module itself, not hardcoded, so the two can't drift apart

                futuresWss.handleUpgrade(req, socket, head, (ws) => {
                    futuresWss.emit("connection", ws, req);
                });

                break;

            default:
                socket.destroy();
        }

    });


}

module.exports = attachWebSocketManager;