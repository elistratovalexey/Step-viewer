import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val ciCode = (project.findProperty("ciVersionCode") as String?)?.toIntOrNull() ?: 1
val ciName = (project.findProperty("ciVersionName") as String?) ?: "1.0"
val stableKey = rootProject.file("signing/stepviewer.jks")

android {
    namespace = "com.stepviewer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.stepviewer"
        minSdk = 24
        targetSdk = 34
        versionCode = ciCode
        versionName = ciName
    }

    signingConfigs {
        create("stable") {
            if (stableKey.exists()) {
                storeFile = stableKey
                storePassword = "stepviewer"
                keyAlias = "stepviewer"
                keyPassword = "stepviewer"
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            if (stableKey.exists()) signingConfig = signingConfigs.getByName("stable")
        }
        release {
            isMinifyEnabled = false
            signingConfig = if (stableKey.exists()) signingConfigs.getByName("stable")
                            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    androidResources { noCompress += listOf("wasm") }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
}

tasks.register("checkWebLibs") {
    doLast {
        val lib = file("src/main/assets/viewer/lib")
        val need = listOf("occt-import-js.js", "occt-import-js.wasm", "three.module.js",
                          "addons/controls/OrbitControls.js")
        val missing = need.filterNot { File(lib, it).exists() }
        if (missing.isNotEmpty()) throw GradleException(
            "Нет файлов: $missing. Запустите scripts/fetch-libs.sh (нужен Node.js)."
        )
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn("checkWebLibs") }
