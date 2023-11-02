module.exports = {
    module: {
        rules: [
            {
                test: /\.m?js/, // fix:issue: https://github.com/webpack/webpack/issues/11467
                resolve: {
                  fullySpecified: false,
                },
              },
            ]
    }

};