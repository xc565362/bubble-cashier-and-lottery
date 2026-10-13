FROM node:24-bookworm-slim
WORKDIR /app
COPY coupons/store.cjs coupons/http.cjs coupons/server.cjs coupons/catalog-contract.cjs ./coupons/
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production COUPON_ENV=production COUPON_DATA_DIR=/data HOST=0.0.0.0 PORT=3910
EXPOSE 3910
VOLUME ["/data"]
CMD ["node", "coupons/server.cjs"]
