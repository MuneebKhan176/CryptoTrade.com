const { WebSocketServer } = require("ws");

const chatGateway = require("./chatrooms_ws");
const marketGateway = require("./marketData_ws");

function attachWebSocketManager(server) {

    const chatWss = new WebSocketServer({ noServer: true });
    const marketWss = new WebSocketServer({ noServer: true });

    chatGateway.initialize(chatWss);
    marketGateway.initialize(marketWss);

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

            default:
                socket.destroy();
        }

    });


}

module.exports = attachWebSocketManager;