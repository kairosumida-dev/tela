# Compartilhar Tela

Compartilhamento de tela de uma pessoa para outra, sem cadastro. O navegador de quem apresenta pede autorização a cada sessão e oferece as fontes disponíveis, como uma janela de aplicativo, aba ou tela inteira. Esta versão transmite vídeo sem áudio.

## Teste local

Na raiz do projeto, inicie a página e a sinalização em dois terminais com Python 3 e Node.js instalados.

```sh
python3 -m http.server 8176 --bind 127.0.0.1
```

```sh
npx wrangler dev --config signaling/wrangler.toml --port 18787 --ip 127.0.0.1
```

Abra [a página local](http://127.0.0.1:8176/) em um navegador de computador. Clique em **Compartilhar tela**, confirme a fonte no navegador e abra o convite em outra aba. Para testar entre computadores, publique a página em HTTPS e use o endereço público da etapa seguinte.

## GitHub Pages

Publique a raiz do repositório no GitHub Pages com HTTPS ativo. Com a opção padrão em `config.js`, a própria página prepara a conexão manualmente.

1. Quem apresenta autoriza uma fonte e envia o link de convite.
2. Quem assiste abre o link, copia o código de resposta e o devolve a quem apresenta.
3. Quem apresenta cola o código na página e seleciona **Conectar espectador**.

Abra a página local com `#manual` no fim do endereço para testar esse mesmo fluxo.

## Convite automático com Cloudflare (opcional)

1. Em `signaling/wrangler.toml`, troque `ALLOWED_ORIGIN` pela origem pública do GitHub Pages, por exemplo `https://seu-usuario.github.io`. Use a origem sem o nome do repositório e sem barra final.
2. Com o Wrangler conectado à sua conta Cloudflare, execute `npx wrangler deploy --config signaling/wrangler.toml`. O arquivo já declara a sala com armazenamento SQLite, compatível com o plano gratuito de Workers.
3. Em `config.js`, configure `window.SIGNALING_URL` com o endereço do Worker em `wss://`. Use apenas o endereço público, sem chaves.
4. Publique a raiz do repositório no GitHub Pages e mantenha HTTPS ativo.

O Worker só encaminha os dados de conexão. O vídeo viaja entre os navegadores por WebRTC. Esta versão usa STUN para encontrar uma conexão direta. Se a rede exigir retransmissão, será preciso integrar um serviço TURN antes de usar o compartilhamento naquela rede.

O convite dá acesso a um espectador por vez enquanto a sala está aberta. Envie o endereço apenas para quem deve assistir. Ao parar o compartilhamento ou fechar a página de quem apresenta, a sala é encerrada.
