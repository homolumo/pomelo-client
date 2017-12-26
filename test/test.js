const PomeloClient = require('../pomelo-client');
const ava = require('ava');

const params = {
  host: '127.0.0.1',
  port: 3250,
};

let pomeloClient;

ava.before(() => {
  pomeloClient = new PomeloClient();
});

ava('test', async (t) => {
  pomeloClient.on('disconnect', (event) => {
    if (event.code === 1000) {
      t.log('normal close by owner');
    } else {
      t.log('network disconnect');
    }
  });

  pomeloClient.on('close', () => {
    t.log('closed');
  });

  await pomeloClient.init(params);

  const resp = await pomeloClient.request('gate.gateHandler.queryEntry');

  t.log(`entry gate data: ${JSON.stringify(resp)}`);
  if (resp.code !== 0) {
    t.log('fail and reconnect');
    t.fail();
  }

  await pomeloClient.init(resp.data);
  t.log('connect connector ok');
  t.pass();
});

ava.after(() => {
  pomeloClient.close();
});
